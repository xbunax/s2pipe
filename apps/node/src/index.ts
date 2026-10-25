import { HttpServer } from "@webtools/expressapi";
import { authorize } from "@/middlewares/auth.ts";
import { startPico } from "@/services/pico.ts";
import mainRouter from "@/routes/index.ts";
import { config } from "@/config.ts";

await startPico();

const httpServer = new HttpServer()
	.use(authorize)
	.use(mainRouter);

export type AppRouter = typeof httpServer;
console.info(`node :${config.nodePort}`);
httpServer.listen(config.nodePort);

// Slick/expressapi binds IPv4 only. Keep that listener for existing clients and
// add a parallel IPv6 listener on the same port for IPv6 page/API/WebSocket
// access. The Pico control path itself remains IPv4.
try {
	Deno.serve({ port: config.nodePort, hostname: "::" }, httpServer.fetch);
	console.info(`node [::]:${config.nodePort}`);
} catch (error) {
	console.warn(
		`node IPv6 listener unavailable: ${error instanceof Error ? error.message : String(error)}`,
	);
}
