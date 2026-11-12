import { describe, expect, it } from "vitest";
import { fetchRemoteImage, FetchRemoteError } from "../remote";

/**
 * The remote branch of the render endpoint is the SSRF surface, so these tests
 * pin the URL policy rather than the plumbing: https only, no private or
 * loopback destinations, no redirects followed, a byte cap and a timeout.
 *
 * `fetch` is injected by the caller (route handlers pass the global), which is
 * what makes the policy testable without a network.
 */

const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);

function response(body: Uint8Array | ReadableStream<Uint8Array> | null, init: ResponseInit = {}): Response {
  return new Response(body === null ? null : (body as unknown as BodyInit), init);
}

const ok = (body: Uint8Array) => () => Promise.resolve(response(body));

describe("fetchRemoteImage — URL policy", () => {
  it("refuses non-https and non-http schemes before any fetch", async () => {
    let called = false;
    const fetchImpl = () => {
      called = true;
      return Promise.resolve(response(PNG));
    };
    for (const url of [
      "file:///etc/passwd",
      "ftp://example.com/a.png",
      "data:image/png;base64,AAAA",
      "javascript:alert(1)",
      "//example.com/a.png",
      "not a url",
    ]) {
      await expect(fetchRemoteImage(url, { fetchImpl })).rejects.toThrow(FetchRemoteError);
    }
    expect(called).toBe(false);
  });

  it("refuses plain http — the agent can always point at https", async () => {
    await expect(
      fetchRemoteImage("http://example.com/a.png", { fetchImpl: ok(PNG) }),
    ).rejects.toMatchObject({ reason: "insecure_scheme" });
  });

  it("refuses loopback, link-local and private destinations", async () => {
    const fetchImpl = ok(PNG);
    for (const url of [
      "https://127.0.0.1/a.png",
      "https://localhost/a.png",
      "https://[::1]/a.png",
      "https://10.1.2.3/a.png",
      "https://192.168.1.10/a.png",
      "https://172.16.0.5/a.png",
      "https://169.254.169.254/latest/meta-data",
      "https://0.0.0.0/a.png",
      "https://foo.localhost/a.png",
      "https://metadata.google.internal/a.png",
    ]) {
      await expect(fetchRemoteImage(url, { fetchImpl })).rejects.toMatchObject({
        reason: "destination_not_allowed",
      });
    }
  });

  /**
   * The URL parser normalizes several spellings of the same address, and an
   * address is refused by VALUE regardless of how it was written. Each case
   * below reached a private/loopback destination before the policy expanded
   * IPv6 literals and stripped the DNS root dot.
   */
  it("refuses alternate spellings of loopback and private addresses", async () => {
    const fetchImpl = ok(PNG);
    for (const url of [
      "https://127.0.0.1./a.png", // trailing dot (DNS root)
      "https://localhost./a.png",
      "https://metadata.google.internal./a.png",
      "https://2130706433/a.png", // decimal 127.0.0.1
      "https://0x7f.0.0.1/a.png", // hex octet
      "https://0177.0.0.1/a.png", // octal octet
      "https://[::ffff:127.0.0.1]/a.png", // IPv4-mapped, dotted tail
      "https://[::ffff:7f00:1]/a.png", // IPv4-mapped, hex form
      "https://[::ffff:a9fe:a9fe]/a.png", // 169.254.169.254, hex form
      "https://[::127.0.0.1]/a.png", // IPv4-compatible
      "https://[64:ff9b::7f00:1]/a.png", // NAT64
      "https://[64:ff9b:1::7f00:1]/a.png", // local-use NAT64
      "https://[2002:7f00:1::]/a.png", // 6to4
      "https://[fe80::1]/a.png", // link-local
      "https://[fc00::1]/a.png", // unique-local
      "https://[fd12:3456::1]/a.png",
    ]) {
      await expect(fetchRemoteImage(url, { fetchImpl })).rejects.toMatchObject({
        reason: "destination_not_allowed",
      });
    }
  });

  it("still allows a public literal and a public IPv6 host", async () => {
    const fetchImpl = ok(PNG);
    for (const url of ["https://93.184.216.34/a.png", "https://[2606:2800:220:1::1]/a.png"]) {
      await expect(fetchRemoteImage(url, { fetchImpl })).resolves.toMatchObject({
        mime: "image/png",
      });
    }
  });

  it("allows a public https host", async () => {
    const result = await fetchRemoteImage("https://example.com/a.png", {
      fetchImpl: ok(PNG),
    });
    expect(result.mime).toBe("image/png");
    expect(Array.from(result.bytes)).toEqual(Array.from(PNG));
  });

  it("does not follow redirects — a 302 to loopback is the classic SSRF bounce", async () => {
    const fetchImpl = () =>
      Promise.resolve(response(null, { status: 302, headers: { location: "http://127.0.0.1/" } }));
    await expect(fetchRemoteImage("https://example.com/a.png", { fetchImpl })).rejects.toMatchObject(
      { reason: "bad_status" },
    );
    const [, init] = (await captureInit(fetchImpl)) ?? [];
    expect(init?.redirect).toBe("manual");
  });

  it("refuses a body that is not one of the served image types", async () => {
    await expect(
      fetchRemoteImage("https://example.com/a.png", {
        fetchImpl: ok(new Uint8Array(Buffer.from("<!doctype html><script>x</script>", "latin1"))),
      }),
    ).rejects.toMatchObject({ reason: "unsupported_type" });
  });

  it("refuses a body over the byte cap", async () => {
    await expect(
      fetchRemoteImage("https://example.com/a.png", {
        fetchImpl: ok(PNG),
        maxBytes: 4,
      }),
    ).rejects.toMatchObject({ reason: "too_large" });
  });

  it("refuses a declared length over the cap without reading the body", async () => {
    // A real ReadableStream is prefilled by the platform before our code runs,
    // so watching its `pull` would prove nothing. Watch `getReader` instead —
    // that is the call this function must not make when the length is already
    // over the cap.
    let readerTaken = false;
    const fakeBody = {
      getReader() {
        readerTaken = true;
        throw new Error("body must not be read");
      },
      cancel: () => Promise.resolve(),
    };
    const fetchImpl = () =>
      Promise.resolve({
        status: 200,
        headers: new Headers({ "content-length": "99999999" }),
        body: fakeBody,
      } as unknown as Response);
    await expect(
      fetchRemoteImage("https://example.com/a.png", { fetchImpl, maxBytes: 1024 }),
    ).rejects.toMatchObject({ reason: "too_large" });
    expect(readerTaken).toBe(false);
  });

  it("reports a transport failure as a fetch error, never as a hang", async () => {
    const fetchImpl = () => Promise.reject(new Error("ECONNRESET"));
    await expect(fetchRemoteImage("https://example.com/a.png", { fetchImpl })).rejects.toMatchObject(
      { reason: "fetch_failed" },
    );
  });

  it("aborts on the timeout", async () => {
    const fetchImpl = (_url: URL | RequestInfo, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    await expect(
      fetchRemoteImage("https://example.com/a.png", { fetchImpl, timeoutMs: 10 }),
    ).rejects.toMatchObject({ reason: "timeout" });
  });

  it("holds the timeout through the body read, not just the headers", async () => {
    // Headers arrive at once; the body then never produces another chunk.
    // Without a live deadline this hangs forever — the documented 5s cap would
    // be a promise about the request line only.
    const stalled = new ReadableStream<Uint8Array>({
      start() {
        /* deliberately never enqueues or closes */
      },
      cancel() {
        /* the reader's cancel path */
      },
    });
    const fetchImpl = () => Promise.resolve(response(stalled));
    await expect(
      fetchRemoteImage("https://example.com/a.png", { fetchImpl, timeoutMs: 20 }),
    ).rejects.toMatchObject({ reason: "timeout" });
  });
});

async function captureInit(
  fetchImpl: typeof fetch,
): Promise<[string, RequestInit] | null> {
  let captured: [string, RequestInit] | null = null;
  const spy: typeof fetch = (input, init) => {
    captured = [String(input), init ?? {}];
    return fetchImpl(input, init);
  };
  try {
    await fetchRemoteImage("https://example.com/a.png", { fetchImpl: spy });
  } catch {
    // expected
  }
  return captured;
}
