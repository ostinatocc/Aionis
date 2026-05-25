export type AionisJsonPrimitive = string | number | boolean | null;

export type AionisJsonValue =
  | AionisJsonPrimitive
  | AionisJsonValue[]
  | { [key: string]: AionisJsonValue };

export type AionisJsonObject = { [key: string]: AionisJsonValue };

export type AionisRequestPayload = Record<string, unknown>;
export type AionisResponsePayload = unknown;
export type AionisQueryScalar = string | number | boolean | null | undefined;
export type AionisQueryValue = AionisQueryScalar | AionisQueryScalar[];
export type AionisQueryPayload = Record<string, AionisQueryValue>;

export type AionisFetch = typeof fetch;

export type AionisClientOptions = {
  baseUrl: string;
  fetch?: AionisFetch;
  headers?: Record<string, string>;
};

export type AionisRequestOptions<TRequest extends AionisRequestPayload> = {
  path: string;
  payload: TRequest;
};

export type AionisGetOptions<TQuery extends AionisQueryPayload> = {
  path: string;
  query?: TQuery;
};

export type AionisHttpClient = {
  post<TRequest extends AionisRequestPayload, TResponse = AionisResponsePayload>(
    args: AionisRequestOptions<TRequest>,
  ): Promise<TResponse>;
  get<TQuery extends AionisQueryPayload, TResponse = AionisResponsePayload>(
    args: AionisGetOptions<TQuery>,
  ): Promise<TResponse>;
};
