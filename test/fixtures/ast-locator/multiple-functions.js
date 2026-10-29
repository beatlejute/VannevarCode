function registerProvider(name, factory) {
    const key = String(name).toLowerCase();
    providers.set(key, factory);
    return key;
}

function resolveProvider(name, factory) {
    const key = String(name).toUpperCase();
    cache.set(key, factory);
    return key;
}

function listProviders() {
    return Array.from(providers.keys());
}

(() => {
    function registerProvider(name, factory) {
        return factory(name);
    }
})();
