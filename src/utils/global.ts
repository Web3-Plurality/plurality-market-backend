// In-memory SIWE nonce store — move to redis if this ever runs multi-instance.
export const memoryStoreNonce = new Map(); // key: address, value: nonce
