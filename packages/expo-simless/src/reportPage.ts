import fs from "node:fs"
import path from "node:path"
import { PACKAGE_ROOT } from "./process.ts"
import type { Report } from "./report.ts"

const TEMPLATE = path.join(PACKAGE_ROOT, "report", "page.html")

const escapeHtml = (text: string) =>
	text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;")

// The page reads the report from a JSON script tag, so it needs no server and the images stay files beside it.
export const reportPage = (report: Report): string =>
	fs
		.readFileSync(TEMPLATE, "utf8")
		.replace("__TITLE__", () => escapeHtml(report.project))
		.replace('"__REPORT_DATA__"', () => JSON.stringify(report).replaceAll("<", "\\u003c"))
