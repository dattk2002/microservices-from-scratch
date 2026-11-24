import { chooseVariant } from './accept.mts';
import { portSetting, sendGreeting, serve } from './http.mts';

if (import.meta.main) {
  await serve('provider', portSetting(3091), (res, _accept, ranges) => {
    sendGreeting(res, chooseVariant(ranges));
  });
}
