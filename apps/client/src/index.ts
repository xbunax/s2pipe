import { Slick } from "@webtools/slick-server";

const port = Number(Deno.env.get("CLIENT_PORT") || 5000);

const app = new Slick(import.meta.dirname!, {
	port,
	lang: "en",
	client: true,
	hotReload: Deno.args.includes("--dev"),
	sharedLibs: ["lucide-preact"],
});

await app.start();

// Slick binds 0.0.0.0 only. On Windows an IPv6 wildcard listener can share the
// same port; forward those connections to the IPv4 Slick server. IPv4 access
// is unchanged, and failure to bind IPv6 leaves the IPv4 page working.
function startIpv6Proxy(listenPort: number): void {
	let listener: Deno.Listener;
	try {
		listener = Deno.listen({ hostname: "::", port: listenPort });
	} catch (error) {
		console.warn(
			`client IPv6 listener unavailable: ${error instanceof Error ? error.message : String(error)}`,
		);
		return;
	}

	console.info(`client [::]:${listenPort}`);
	void (async () => {
		for await (const client of listener) {
			void forward(client, listenPort);
		}
	})();
}

async function forward(client: Deno.Conn, upstreamPort: number): Promise<void> {
	let upstream: Deno.Conn | null = null;
	try {
		upstream = await Deno.connect({ hostname: "127.0.0.1", port: upstreamPort });
		await Promise.all([
			client.readable.pipeTo(upstream.writable).catch(() => {}),
			upstream.readable.pipeTo(client.writable).catch(() => {}),
		]);
	} catch {
		// The browser disconnected or the IPv4 page server is restarting.
	} finally {
		try {
			client.close();
		} catch {
			// ignore
		}
		try {
			upstream?.close();
		} catch {
			// ignore
		}
	}
}

startIpv6Proxy(port);
