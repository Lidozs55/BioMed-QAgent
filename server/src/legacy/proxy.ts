import type { IncomingMessage, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";

import httpProxy from "http-proxy-3";

export interface LegacyProxy {
  web: (request: IncomingMessage, response: ServerResponse) => void;
  ws: (request: IncomingMessage, socket: Duplex, head: Buffer) => void;
  close: () => void;
}

export function createLegacyProxy(target: string): LegacyProxy {
  const proxy = httpProxy.createProxyServer({ target, ws: true, changeOrigin: false });
  const proxySockets = new Set<Socket>();
  proxy.on("open", (socket) => {
    proxySockets.add(socket);
    socket.once("close", () => proxySockets.delete(socket));
  });
  return {
    web(request, response) {
      proxy.web(request, response, (error) => {
        if (!response.headersSent) response.writeHead(502);
        response.end(`Legacy backend proxy failed: ${error.message}`);
      });
    },
    ws(request, socket, head) {
      proxy.ws(request, socket, head, (error) => {
        socket.destroy(error);
      });
    },
    close() {
      for (const socket of proxySockets) socket.destroy();
      proxy.close();
    },
  };
}
