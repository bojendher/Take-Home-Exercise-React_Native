// Lets `node --test` run the app's TypeScript client modules (src/) directly:
// Node strips the types; this hook resolves the `@/` alias, extensionless and
// platform-specific (.web.ts) imports, and stubs the React Native / Expo modules.
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = path.join(ROOT, 'src');
const stub = (name) => new URL(`./stubs/${name}.mjs`, import.meta.url).href;
const STUBS = {
  'expo/fetch': stub('expo-fetch'),
  'expo-network': stub('expo-network'),
  'expo-constants': stub('expo-constants'),
  'react-native': stub('react-native'),
};

registerHooks({
  resolve(specifier, context, next) {
    if (STUBS[specifier]) return { url: STUBS[specifier], shortCircuit: true };
    let target = null;
    if (specifier.startsWith('@/')) target = path.join(SRC, specifier.slice(2));
    else if (specifier.startsWith('.') && context.parentURL?.startsWith(pathToFileURL(SRC).href)) {
      target = fileURLToPath(new URL(specifier, context.parentURL));
    }
    if (target) {
      // The client runs as its web build here (Node has fetch, File, FormData).
      const file = [target, `${target}.web.ts`, `${target}.ts`].find(
        (candidate) => /\.[cm]?[jt]s$/.test(candidate) && existsSync(candidate),
      );
      if (file) return { url: pathToFileURL(file).href, shortCircuit: true };
    }
    return next(specifier, context);
  },
});

globalThis.__DEV__ = true;
