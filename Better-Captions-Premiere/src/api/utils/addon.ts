let addon: any = null;

function loadAddon() {
  const attempts = [
    "bolt-uxp-hybrid.uxpaddon",
    "bolt-uxp-hybrid",
    "./bolt-uxp-hybrid.uxpaddon",
  ];
  for (const name of attempts) {
    try {
      const loaded = require(name);
      console.log(`Addon loaded via "${name}":`, JSON.stringify(Object.keys(loaded || {})));
      if (loaded?.execSync) {
        return loaded;
      }
      if (loaded?.default?.execSync) {
        return loaded.default;
      }
    } catch (e: any) {
      console.log(`Addon require("${name}") failed:`, e?.message);
    }
  }
  return null;
}

export const getAddon = () => {
  if (!addon) addon = loadAddon();
  return addon;
};
