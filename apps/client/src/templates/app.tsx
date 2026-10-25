import type { Template } from "@webtools/slick-server";

export default {
	name: "app",
	favicon: "/favicon.svg",

	styles: [
		"/styles/reset.css",
		"/styles/tokens.css",
		"/styles/ui.css",
		"/styles/app.css",
	],
	scripts: [],

	head: (
		<>
			<meta name="apple-mobile-web-app-capable" content="yes" />
			<meta name="mobile-web-app-capable" content="yes" />
			<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
			<meta name="apple-mobile-web-app-title" content="s2pipe" />
			<meta name="theme-color" content="#07080a" />
		</>
	),
	body: (
		<div id="root">
			<div id="app"></div>
		</div>
	),

	onrequest: null,
} satisfies Template;
