import { resource } from './policy.mts';
import { json, serve } from './server.mts';

if (import.meta.main) await serve('resource', 8096, '/resource', res => json(res, 200, resource));
