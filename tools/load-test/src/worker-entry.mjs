// Worker threads can't use tsx's --import hook for their entry file on Node 20, so load it via the API.
import { tsImport } from 'tsx/esm/api';

await tsImport('./worker.ts', import.meta.url);
