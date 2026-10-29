function resolveProvider(name, factory) {
    const key = String(name).toUpperCase();
    cache.set(key, factory);
    return key;
}
