// @flow
import getSdk from '../get_sdk';
import type GlobalConfig from '../global_config';
import useWatchable from './use_watchable';

/**
 * Returns the {@link GlobalConfig} and updates whenever any key in GlobalConfig changes.
 *
 * @returns the {@link GlobalConfig}
 *
 * @example
 * import {useGlobalConfig} from '@airtable/blocks/ui';
 *
 * function SyncedCounter() {
 *     const globalConfig = useGlobalConfig();
 *     const count = globalConfig.get('count');
 *
 *     const increment = () => globalConfig.set('count', count + 1);
 *     const decrement = () => globalConfig.set('count', count - 1);
 *     const isEnabled = globalConfig.canSet('count');
 *
 *     return (
 *         <React.Fragment>
 *             <button onClick={decrement} disabled={!isEnabled}>-</button>
 *             {count}
 *             <button onClick={increment} disabled={!isEnabled}>+</button>
 *         </React.Fragment>
 *     );
 * }
 */
export default function useGlobalConfig(): GlobalConfig {
    const {globalConfig, session} = getSdk();
    useWatchable(session, ['permissionLevel']);
    useWatchable(globalConfig, ['*']);
    return globalConfig;
}