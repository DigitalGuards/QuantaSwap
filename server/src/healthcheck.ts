import { request } from "node:http";

const rawPort = process.env["PORT"] ?? "8091";
if (!/^[0-9]+$/.test(rawPort)) process.exit(1);
const port = Number(rawPort);

const req = request(
  {
    host: "127.0.0.1",
    port,
    path: "/api/health",
    method: "GET",
    timeout: 4000,
  },
  (res) => {
    res.resume();
    process.exit(res.statusCode === 200 ? 0 : 1);
  },
);

req.once("timeout", () => req.destroy());
req.once("error", () => process.exit(1));
req.end();
