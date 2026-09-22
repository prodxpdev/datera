import type { HttpPort, HttpRequest, HttpResponse } from '@datera/core';

/**
 * The core's HttpPort over Node's global fetch.
 *
 * `AbortSignal.timeout` rather than a manual race: it aborts the underlying socket, so a
 * detection probe against a port that accepts the connection and then says nothing is
 * actually cancelled rather than merely abandoned while the handle leaks.
 */
export class NodeHttp implements HttpPort {
  async send(request: HttpRequest): Promise<HttpResponse> {
    const signal = request.timeoutMs === undefined ? undefined : AbortSignal.timeout(request.timeoutMs);

    const init: RequestInit = { method: request.method };
    if (request.headers !== undefined) init.headers = { ...request.headers };
    if (request.body !== undefined) init.body = request.body;
    if (signal !== undefined) init.signal = signal;

    const response = await fetch(request.url, init);

    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });

    return { status: response.status, headers, body: await response.text() };
  }
}
