/**
 * Credential storage, backed by the OS keychain in real hosts.
 *
 * Phase 1 stores database credentials here (decision D-06); Phase 2 adds model API keys
 * to the same port. A host that cannot provide real protection must throw
 * `SECRET_STORE_UNAVAILABLE` rather than silently degrading to plaintext.
 */
export interface SecretStorePort {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  /** Whether this store is actually backed by protected storage right now. */
  isAvailable(): Promise<boolean>;
}
