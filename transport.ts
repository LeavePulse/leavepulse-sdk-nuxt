import {
	buildFormData,
	buildPath,
	type ConditionalResult,
	parseJson,
	type Transport,
	type TransportRequest,
} from "@leavepulse/sdk";
import { appendHeader, getRequestHeader, getRequestIP, parseCookies } from "h3";
import { useNuxtApp, useRequestEvent, useRuntimeConfig } from "#imports";

type ApiChannel = "platform" | "auth";

/**
 * Auth state the transport needs, abstracted from the app's store. The app
 * wires its own session store to this; the transport never imports it.
 */
export type AuthBridge = {
	readonly accessJwt: string | null;
	readonly refreshToken: string | null;
	/** Session exists (user hydrated) but the access token is not yet live. */
	readonly isRestoring: boolean;
	/** A refresh is already in flight — avoid re-triggering (would self-await). */
	readonly isRefreshing: boolean;
	refresh(): Promise<void>;
};

export type NuxtTransportOptions = {
	/** Auth bridge; omit for unauthenticated transports (public calls). */
	auth?: AuthBridge;
	baseURL?: string;
};

const CHANNEL_RUNTIME_KEYS: Record<
	ApiChannel,
	{ internal: string; public: string }
> = {
	platform: { internal: "apiInternalBase", public: "apiBase" },
	auth: { internal: "authInternalBase", public: "authApiBase" },
};

const RT_COOKIES = ["__Host-rt", "__Secure-rt", "rt"];
const CSRF_COOKIES = ["__Host-csrf", "__Secure-csrf", "csrf"];
const SESSION_COOKIES = [...RT_COOKIES, ...CSRF_COOKIES];

/** First `name=value` pair present among `names`, or undefined. */
function pickCookie(
	cookies: Record<string, string | undefined>,
	names: string[],
): { name: string; value: string } | undefined {
	for (const name of names) {
		const value = cookies[name];
		if (value) return { name, value };
	}
	return undefined;
}

function errorStatus(error: unknown): number | undefined {
	const candidate = (error as { status?: unknown; statusCode?: unknown }) ?? {};
	const value = candidate.status ?? candidate.statusCode;
	return typeof value === "number" ? value : undefined;
}

function baseHasV1Prefix(base: string): boolean {
	try {
		return /\/v1(\/|$)/.test(new URL(base).pathname);
	} catch {
		return /\/v1(\/|$)/.test(base);
	}
}

function shouldUseLocalDevProxy(): boolean {
	if (!import.meta.client) return false;
	const { hostname, protocol } = window.location;
	const isLocalHost =
		hostname === "127.0.0.1" ||
		hostname === "localhost" ||
		hostname.endsWith(".localhost");
	return isLocalHost && protocol.startsWith("http");
}

function getCookieValue(name: string): string | null {
	if (!import.meta.client) return null;
	for (const entry of document.cookie.split("; ")) {
		const [key, ...value] = entry.split("=");
		if (key === name) return decodeURIComponent(value.join("="));
	}
	return null;
}

function getCookieValueAny(names: string[]): string | null {
	for (const name of names) {
		const value = getCookieValue(name);
		if (value) return value;
	}
	return null;
}

function hasClientSessionCookies(): boolean {
	return Boolean(getCookieValueAny(SESSION_COOKIES));
}

function safeUseRequestEvent() {
	if (!import.meta.server) return undefined;
	try {
		return useRequestEvent();
	} catch {
		return undefined;
	}
}

/** Best-effort real client IP from the incoming SSR request, to forward to the
 * upstream API. Mirrors the server-side resolution order (proxy headers first,
 * then the forwarded chain, then the socket). */
function resolveForwardedClientIp(
	event: ReturnType<typeof safeUseRequestEvent>,
): string | undefined {
	if (!event) return undefined;
	for (const name of ["cf-connecting-ip", "true-client-ip", "x-real-ip"]) {
		const value = getRequestHeader(event, name);
		if (value?.trim()) return value.trim();
	}
	const forwardedFor = getRequestHeader(event, "x-forwarded-for");
	if (forwardedFor) {
		const first = forwardedFor.split(",")[0]?.trim();
		if (first) return first;
	}
	try {
		return getRequestIP(event, { xForwardedFor: true }) ?? undefined;
	} catch {
		return undefined;
	}
}

function canMutateResponseHeaders(
	event: ReturnType<typeof safeUseRequestEvent>,
) {
	if (!import.meta.server || !event) return false;
	const res = (event as { node?: { res?: unknown } }).node?.res as
		| { headersSent?: boolean; writableEnded?: boolean; destroyed?: boolean }
		| undefined;
	if (!res) return false;
	return !res.headersSent && !res.writableEnded && !res.destroyed;
}

function hasServerSessionCookies(
	event: ReturnType<typeof safeUseRequestEvent>,
): boolean {
	if (!import.meta.server || !event) return false;
	const cookies = parseCookies(event);
	return SESSION_COOKIES.some((name) => cookies[name]);
}

function readConfigBase(
	source: Record<string, unknown>,
	key: string,
): string | undefined {
	const value = source[key];
	if (typeof value !== "string") return undefined;
	return value.trim() || undefined;
}

function resolveBody(req: TransportRequest): unknown {
	return req.multipart ? buildFormData(req.multipart) : req.body;
}

function readLocale(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	if (value && typeof value === "object" && "value" in value) {
		const inner = (value as { value?: unknown }).value;
		if (typeof inner === "string") return inner;
	}
	return undefined;
}

/** Nuxt `Transport`: SSR cookie/CSRF, per-channel routing, refresh-on-401. */
export class NuxtTransport implements Transport {
	constructor(private readonly opts: NuxtTransportOptions = {}) {}

	async request<T>(req: TransportRequest): Promise<T> {
		const path = buildPath(req);
		return this.requestWithRefresh(path, async () => {
			const ctx = this.createFetchContext(path);
			return (await $fetch(ctx.requestUrl, this.fetchOptions(req, ctx))) as T;
		});
	}

	async conditional<T>(req: TransportRequest): Promise<ConditionalResult<T>> {
		const path = buildPath(req);
		return this.requestWithRefresh(path, async () => {
			const ctx = this.createFetchContext(path);
			if (req.ifNoneMatch) ctx.headers["If-None-Match"] = req.ifNoneMatch;
			const response = await $fetch.raw(ctx.requestUrl, {
				...this.fetchOptions(req, ctx),
				ignoreResponseError: true,
			});
			if (response.status === 404) return { status: "not_found" };
			const etag = response.headers.get("etag") ?? undefined;
			if (response.status === 304) return { status: "not_modified", etag };
			return { status: "modified", data: response._data as T, etag };
		});
	}

	private fetchOptions(
		req: TransportRequest,
		ctx: ReturnType<typeof this.createFetchContext>,
	) {
		return {
			...(ctx.base ? { baseURL: ctx.base } : {}),
			method: req.method as never,
			body: resolveBody(req) as never,
			headers: ctx.headers,
			credentials: "include" as const,
			parseResponse: parseJson,
			onResponse: ({ response }: { response: { headers: unknown } }) =>
				this.forwardSetCookieHeaders(
					ctx.requestEvent,
					ctx.isAuthTarget,
					response,
				),
		};
	}

	private resolveChannel(url: string): ApiChannel {
		return url.startsWith("/auth/") || url === "/auth" ? "auth" : "platform";
	}

	private shouldBypassAutoRefresh(url: string): boolean {
		return url === "/auth/refresh";
	}

	private resolveTarget(url: string) {
		const config = useRuntimeConfig();
		const configRecord = config as Record<string, unknown>;
		const publicConfig = config.public as Record<string, unknown>;
		const channel = this.resolveChannel(url);
		const keys = CHANNEL_RUNTIME_KEYS[channel];
		const localDevProxyBase = shouldUseLocalDevProxy()
			? `/api/_lp/${channel}`
			: undefined;
		const internalBase = import.meta.server
			? readConfigBase(configRecord, keys.internal)
			: undefined;
		const publicBase = readConfigBase(publicConfig, keys.public);
		const channelBase = internalBase || publicBase;
		const base = this.opts.baseURL ?? (localDevProxyBase || channelBase);
		return {
			channel,
			base,
			baseHasPlatformPrefix: base ? baseHasV1Prefix(base) : false,
		};
	}

	private resolveLocale(): string | undefined {
		try {
			const nuxtApp = useNuxtApp();
			const i18n = (nuxtApp as { $i18n?: unknown }).$i18n as
				| { locale?: unknown; global?: { locale?: unknown } }
				| undefined;
			return (
				readLocale(i18n?.locale) ||
				readLocale(i18n?.global?.locale) ||
				undefined
			);
		} catch {
			return undefined;
		}
	}

	private createFetchContext(url: string) {
		const auth = this.opts.auth;
		const requestEvent = safeUseRequestEvent();
		const target = this.resolveTarget(url);
		const requestUrl =
			target.channel === "platform" && target.baseHasPlatformPrefix
				? url.replace(/^\/v1(?=\/|$)/, "") || "/"
				: url;
		const headers: Record<string, string> = {};
		const locale = this.resolveLocale();
		if (locale) headers["Accept-Language"] = locale;

		const isAuthTarget = target.channel === "auth";

		if (import.meta.server && requestEvent && isAuthTarget) {
			const cookies = parseCookies(requestEvent);
			const rt = pickCookie(cookies, RT_COOKIES);
			const csrf = pickCookie(cookies, CSRF_COOKIES);
			const parts = [rt, csrf]
				.filter((c): c is { name: string; value: string } => Boolean(c))
				.map((c) => `${c.name}=${c.value}`);
			if (parts.length > 0) {
				headers.Cookie = parts.join("; ");
				headers["X-Auth-Client"] = "web";
				if (csrf) headers["X-CSRF-Token"] = csrf.value;
			}
		}

		// SSR: the upstream API sees the Nuxt server's socket, not the browser.
		// Forward the real client IP so per-IP logic (rate limiting, audit) keys
		// on the user, not on the shared Nuxt host — otherwise every visitor
		// shares one bucket and trips the limiter together (429 storms on login).
		if (import.meta.server && requestEvent) {
			const clientIp = resolveForwardedClientIp(requestEvent);
			if (clientIp) {
				headers["X-Forwarded-For"] = clientIp;
				headers["X-Real-IP"] = clientIp;
			}
		}

		if (import.meta.client) {
			headers["X-Auth-Client"] = "web";
			const csrfToken = getCookieValueAny(CSRF_COOKIES);
			if (csrfToken) headers["X-CSRF-Token"] = csrfToken;
		}
		if (auth?.accessJwt) {
			headers.Authorization = `Bearer ${auth.accessJwt}`;
		}

		return {
			requestUrl,
			headers,
			isAuthTarget,
			base: target.base,
			requestEvent,
		};
	}

	private forwardSetCookieHeaders(
		requestEvent: ReturnType<typeof safeUseRequestEvent>,
		isAuthTarget: boolean,
		response: { headers: unknown },
	) {
		if (!import.meta.server || !isAuthTarget || !requestEvent) return;
		if (!canMutateResponseHeaders(requestEvent)) return;
		const headerGetter = response.headers as {
			getSetCookie?: () => string[];
			get: (key: string) => string | null;
		};
		const setCookies =
			typeof headerGetter.getSetCookie === "function"
				? headerGetter.getSetCookie()
				: headerGetter.get("set-cookie");
		if (!setCookies) return;
		const cookies = Array.isArray(setCookies) ? setCookies : [setCookies];
		for (const cookie of cookies) {
			if (!canMutateResponseHeaders(requestEvent)) return;
			try {
				appendHeader(requestEvent, "set-cookie", cookie);
			} catch {
				return;
			}
		}
	}

	private async requestWithRefresh<T>(
		url: string,
		attempt: () => Promise<T>,
	): Promise<T> {
		const auth = this.opts.auth;
		const requestEvent = safeUseRequestEvent();

		if (!auth || this.shouldBypassAutoRefresh(url)) return attempt();

		if (import.meta.client && auth.isRestoring && !auth.isRefreshing) {
			try {
				await auth.refresh();
			} catch {
				// proceed and let the request fail naturally if still unauthenticated
			}
		}

		try {
			return await attempt();
		} catch (error) {
			const canAttemptRefresh = import.meta.server
				? hasServerSessionCookies(requestEvent)
				: hasClientSessionCookies() || !!auth.refreshToken;
			if (
				errorStatus(error) === 401 &&
				canAttemptRefresh &&
				!auth.isRefreshing
			) {
				await auth.refresh();
				return await attempt();
			}
			throw error;
		}
	}
}
