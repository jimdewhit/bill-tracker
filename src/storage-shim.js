/* Stand-in for the window.storage.get/set API provided by the Claude.ai
   artifact sandbox this component was originally built in — backed by
   localStorage so the app persists data in a regular browser. */
if (!window.storage) {
  window.storage = {
    async get(key, _shared) {
      const raw = localStorage.getItem(key);
      return { value: raw === null ? undefined : raw };
    },
    async set(key, value, _shared) {
      localStorage.setItem(key, value);
      return true;
    },
  };
}
