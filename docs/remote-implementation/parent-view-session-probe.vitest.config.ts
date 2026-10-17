import {mergeConfig} from 'vitest/config';
import base from '../../vitest.config';
const config=mergeConfig(base,{});
config.test={...config.test,include:['docs/remote-implementation/parent-view-session-probe.test.ts']};
export default config;
