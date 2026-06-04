export type LiteRuntimeStoreSession = {
  sandboxStoreAccess: unknown;
};

export interface LiteRuntimeStore {
  readonly backend: "lite_sqlite";
  withClient<T>(fn: (session: LiteRuntimeStoreSession) => Promise<T>): Promise<T>;
  withTx<T>(fn: (session: LiteRuntimeStoreSession) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
