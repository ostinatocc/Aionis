import { AionisRuntimeSdkHttpError } from "../error.js";
import type {
  AionisClientOptions,
  AionisHttpClient,
  AionisQueryPayload,
  AionisRequestPayload,
  AionisResponsePayload,
} from "../types.js";

function trimBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "");
}

function appendQuery(url: string, query?: AionisQueryPayload): string {
  if (!query) return url;
  const params = new URLSearchParams();
  for (const [key, rawValue] of Object.entries(query)) {
    if (rawValue === undefined) continue;
    const values = Array.isArray(rawValue) ? rawValue : [rawValue];
    for (const value of values) {
      if (value === undefined) continue;
      if (value === null) {
        params.append(key, "");
      } else {
        params.append(key, String(value));
      }
    }
  }
  const rendered = params.toString();
  return rendered.length > 0 ? `${url}?${rendered}` : url;
}

async function parseJson(response: Response): Promise<unknown> {
  return await response.json().catch(() => null);
}

export function createAionisRuntimeHttpClient(options: AionisClientOptions): AionisHttpClient {
  const baseUrl = trimBaseUrl(options.baseUrl);
  const fetchImpl = options.fetch ?? fetch;
  const defaultHeaders = options.headers ?? {};

  return {
    async post<TRequest extends AionisRequestPayload, TResponse = AionisResponsePayload>(
      args: {
        path: string;
        payload: TRequest;
      },
    ): Promise<TResponse> {
      const response = await fetchImpl(`${baseUrl}${args.path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...defaultHeaders,
        },
        body: JSON.stringify(args.payload),
      });

      const payload = await parseJson(response);
      if (!response.ok) {
        throw new AionisRuntimeSdkHttpError({
          status: response.status,
          payload,
        });
      }

      return payload as TResponse;
    },

    async get<TQuery extends AionisQueryPayload, TResponse = AionisResponsePayload>(
      args: {
        path: string;
        query?: TQuery;
      },
    ): Promise<TResponse> {
      const response = await fetchImpl(appendQuery(`${baseUrl}${args.path}`, args.query), {
        method: "GET",
        headers: {
          ...defaultHeaders,
        },
      });

      const payload = await parseJson(response);
      if (!response.ok) {
        throw new AionisRuntimeSdkHttpError({
          status: response.status,
          payload,
        });
      }

      return payload as TResponse;
    },
  };
}
