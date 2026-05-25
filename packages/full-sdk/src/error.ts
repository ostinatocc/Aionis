export class AionisRuntimeSdkHttpError extends Error {
  readonly status: number;
  readonly payload: unknown;

  constructor(args: {
    status: number;
    payload: unknown;
    message?: string;
  }) {
    super(args.message ?? `Aionis runtime request failed with status ${args.status}`);
    this.name = "AionisRuntimeSdkHttpError";
    this.status = args.status;
    this.payload = args.payload;
  }
}
