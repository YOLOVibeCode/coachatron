import type { Server } from 'node:http';

/** Listens on an ephemeral port on 127.0.0.1, the address tests connect to,
 * and resolves with the port once bound.
 *
 * Why not a bare listen(0): that binds every interface, and macOS will hand
 * it a port number another program (an editor, a VPN, a local tool) already
 * holds on 127.0.0.1. A request to 127.0.0.1:<port> then reaches that
 * program instead, and the test hangs for 300s or gets its 401. An explicit
 * 127.0.0.1 bind can never take such a port. Binding with a host is
 * asynchronous, so the port is read on 'listening', not right after listen(). */
export function listenLoopback(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      resolve(typeof address === 'object' && address ? address.port : 0);
    });
  });
}
