import { type HttpRequest, type HttpResponse, Router } from "@webtools/expressapi";
import { config } from "@/config.ts";

const PATHS = ["switch", "switch-lite", "switch-audio"];

async function forward(req: HttpRequest, res: HttpResponse): Promise<Response> {
	const url = new URL(req.raw.url);
	url.protocol = "http:";
	url.host = `${config.mediaHost}:${config.mediaPort}`;

	const headers = new Headers(req.raw.headers);
	headers.delete("host");
	headers.delete("authorization");

	try {
		const upstream = await fetch(url, {
			method: req.raw.method,
			headers,
			body: await req.raw.arrayBuffer(),
			redirect: "manual",
		});

		for (const [name, value] of upstream.headers) {
			if (name.toLowerCase().startsWith("access-control-")) continue;
			res.setHeader(name, value);
		}

		const location = upstream.headers.get("location");
		if (location) {
			const loc = new URL(location, url);
			res.setHeader("Location", loc.pathname + loc.search);
		}

		res.setHeader("Access-Control-Expose-Headers", "location, link");
		return res.status(upstream.status).send(upstream.body);
	} catch {
		return res.status(502).send("whep_unavailable");
	}
}

const router = new Router();
for (const path of PATHS) {
	router
		.post(`/${path}/whep`, forward)
		.patch(`/${path}/whep/:session`, forward)
		.delete(`/${path}/whep/:session`, forward);
}

export default router;
