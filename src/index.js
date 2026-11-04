// Wrangler 入口：仅导出 fetch 处理器，逻辑在 router.js
import { handleRequest } from "./router.js";

export default {
  fetch: handleRequest,
};
