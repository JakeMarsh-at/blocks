// @flow
import {isEnumValue, fireAndForgetPromise, entries, has, values} from '../private_utils';
import {invariant} from '../error_utils';
import {type BaseData} from '../types/base';
import {type TableId, type TableData} from '../types/table';
import {type FieldId} from '../types/field';
import {type RecordId, type RecordData} from '../types/record';
import {type ViewId} from '../types/view';
import {type AirtableInterface} from '../injected/airtable_interface';
import getSdk from '../get_sdk';
import AbstractModelWithAsyncData from './abstract_model_with_async_data';
import Record from './record';
import ViewDataStore from './view_data_store';

export const WatchableRecordStoreKeys = Object.freeze({
    records: ('records': 'records'),
    recordIds: ('recordIds': 'recordIds'),
    cellValues: ('cellValues': 'cellValues'),
});
const WatchableCellValuesInFieldKeyPrefix = 'cellValuesInField:';
const WatchableRecordIdsInViewKeyPrefix = 'recordIdsInView:';
const WatchableRecordColorsInViewKeyPrefix = 'recordColorsInView:';

export type WatchableRecordStoreKey = $Values<typeof WatchableRecordStoreKeys> | string;

/**
 * One RecordStore exists per table, and contains all the record data associated with that table.
 * Table itself is for schema information only, so isn't the appropriate place for this data.
 *
 * @private
 */
class RecordStore extends AbstractModelWithAsyncData<TableData, WatchableRecordStoreKey> {
    static _className = 'RecordStore';
    static _isWatchableKey(key: string): boolean {
        return (
            isEnumValue(WatchableRecordStoreKeys, key) ||
            key.startsWith(WatchableCellValuesInFieldKeyPrefix) ||
            key.startsWith(WatchableRecordIdsInViewKeyPrefix) ||
            key.startsWith(WatchableRecordColorsInViewKeyPrefix)
        );
    }
    static _shouldLoadDataForKey(key: WatchableRecordStoreKey): boolean {
        return key === WatchableRecordStoreKeys.cellValues;
    }

    +tableId: TableId;
    _recordModelsById: {[RecordId]: Record | void} = {};
    +_primaryFieldId: FieldId;
    +_airtableInterface: AirtableInterface;
    +_viewDataStoresByViewId: {[ViewId]: ViewDataStore | void} = {};

    _areCellValuesLoadedByFieldId: {[FieldId]: boolean | void} = {};
    _pendingCellValuesLoadPromiseByFieldId: {
        [FieldId]: Promise<Array<WatchableRecordStoreKey>> | void,
    } = {};
    _cellValuesRetainCountByFieldId: {[FieldId]: number | void} = {};

    constructor(baseData: BaseData, airtableInterface: AirtableInterface, tableId: TableId) {
        super(baseData, `${tableId}-RecordStore`);

        this._airtableInterface = airtableInterface;
        this.tableId = tableId;
        this._primaryFieldId = this._data.primaryFieldId;
    }

    getViewDataStore(viewId: ViewId): ViewDataStore {
        if (this._viewDataStoresByViewId[viewId]) {
            return this._viewDataStoresByViewId[viewId];
        }
        invariant(this._data.viewsById[viewId], 'view must exist');
        const viewDataStore = new ViewDataStore(
            this._baseData,
            this,
            this._airtableInterface,
            viewId,
        );
        this._viewDataStoresByViewId[viewId] = viewDataStore;
        return viewDataStore;
    }

    watch(
        keys: WatchableRecordStoreKey | Array<WatchableRecordStoreKey>,
        callback: Function,
        context?: ?Object,
    ): Array<WatchableRecordStoreKey> {
        const validKeys = super.watch(keys, callback, context);
        const fieldIdsToLoad = this._getFieldIdsToLoadFromWatchableKeys(validKeys);
        if (fieldIdsToLoad.length > 0) {
            fireAndForgetPromise(this.loadCellValuesInFieldIdsAsync.bind(this, fieldIdsToLoad));
        }
        return validKeys;
    }

    unwatch(
        keys: WatchableRecordStoreKey | Array<WatchableRecordStoreKey>,
        callback: Function,
        context?: ?Object,
    ): Array<WatchableRecordStoreKey> {
        const validKeys = super.unwatch(keys, callback, context);
        const fieldIdsToUnload = this._getFieldIdsToLoadFromWatchableKeys(validKeys);
        if (fieldIdsToUnload.length > 0) {
            this.unloadCellValuesInFieldIds(fieldIdsToUnload);
        }
        return validKeys;
    }

    _getFieldIdsToLoadFromWatchableKeys(keys: Array<WatchableRecordStoreKey>): Array<string> {
        const fieldIdsToLoad = [];
        for (const key of keys) {
            if (key.startsWith(WatchableCellValuesInFieldKeyPrefix)) {
                const fieldId = key.substring(WatchableCellValuesInFieldKeyPrefix.length);
                fieldIdsToLoad.push(fieldId);
            } else if (
                key === WatchableRecordStoreKeys.records ||
                key === WatchableRecordStoreKeys.recordIds
            ) {
                fieldIdsToLoad.push(this._getFieldIdForCausingRecordMetadataToLoad());
            }
        }
        return fieldIdsToLoad;
    }

    get _dataOrNullIfDeleted(): TableData | null {
        return this._baseData.tablesById[this.tableId] || null;
    }

    _onChangeIsDataLoaded() {
    }

    /**
     * The records in this table. The order is arbitrary since records are
     * only ordered in the context of a specific view.
     */
    get records(): Array<Record> {
        const recordsById = this._data.recordsById;
        invariant(recordsById, 'Record metadata is not loaded');
        const records = Object.keys(recordsById).map(recordId => {
            const record = this.getRecordByIdIfExists(recordId);
            invariant(record, 'record');
            return record;
        });
        return records;
    }

    /**
     * The record IDs in this table. The order is arbitrary since records are
     * only ordered in the context of a specific view.
     */
    get recordIds(): Array<string> {
        const recordsById = this._data.recordsById;
        invariant(recordsById, 'Record metadata is not loaded');
        return Object.keys(recordsById);
    }

    getRecordByIdIfExists(recordId: string): Record | null {
        const recordsById = this._data.recordsById;
        invariant(recordsById, 'Record metadata is not loaded');
        invariant(typeof recordId === 'string', 'getRecordById expects a string');

        if (!recordsById[recordId]) {
            return null;
        } else {
            if (this._recordModelsById[recordId]) {
                return this._recordModelsById[recordId];
            }
            const newRecord = new Record(
                this._baseData,
                this,
                getSdk().base.getTableById(this.tableId),
                recordId,
            );
            this._recordModelsById[recordId] = newRecord;
            return newRecord;
        }
    }

    /**
     * Record metadata means record IDs, createdTime, and commentCount are loaded.
     * Record metadata must be loaded before creating, deleting, or updating records.
     */
    get isRecordMetadataLoaded(): boolean {
        return !!this._data.recordsById;
    }

    async loadRecordMetadataAsync() {
        return await this.loadCellValuesInFieldIdsAsync([
            this._getFieldIdForCausingRecordMetadataToLoad(),
        ]);
    }

    unloadRecordMetadata() {
        this.unloadCellValuesInFieldIds([this._getFieldIdForCausingRecordMetadataToLoad()]);
    }

    _getFieldIdForCausingRecordMetadataToLoad(): FieldId {
        return this._primaryFieldId;
    }

    areCellValuesLoadedForFieldId(fieldId: FieldId): boolean {
        return this.isDataLoaded || this._areCellValuesLoadedByFieldId[fieldId] || false;
    }

    async loadCellValuesInFieldIdsAsync(fieldIds: Array<FieldId>) {
        const fieldIdsWhichAreNotAlreadyLoadedOrLoading: Array<FieldId> = [];
        const pendingLoadPromises: Array<Promise<Array<WatchableRecordStoreKey>>> = [];
        for (const fieldId of fieldIds) {
            if (this._cellValuesRetainCountByFieldId[fieldId] !== undefined) {
                this._cellValuesRetainCountByFieldId[fieldId]++;
            } else {
                this._cellValuesRetainCountByFieldId[fieldId] = 1;
            }

            if (!this._areCellValuesLoadedByFieldId[fieldId]) {
                const pendingLoadPromise = this._pendingCellValuesLoadPromiseByFieldId[fieldId];
                if (pendingLoadPromise) {
                    pendingLoadPromises.push(pendingLoadPromise);
                } else {
                    fieldIdsWhichAreNotAlreadyLoadedOrLoading.push(fieldId);
                }
            }
        }
        if (fieldIdsWhichAreNotAlreadyLoadedOrLoading.length > 0) {
            const loadFieldsWhichAreNotAlreadyLoadedOrLoadingPromise = this._loadCellValuesInFieldIdsAsync(
                fieldIdsWhichAreNotAlreadyLoadedOrLoading,
            );
            pendingLoadPromises.push(loadFieldsWhichAreNotAlreadyLoadedOrLoadingPromise);
            for (const fieldId of fieldIdsWhichAreNotAlreadyLoadedOrLoading) {
                this._pendingCellValuesLoadPromiseByFieldId[
                    fieldId
                ] = loadFieldsWhichAreNotAlreadyLoadedOrLoadingPromise;
            }
            loadFieldsWhichAreNotAlreadyLoadedOrLoadingPromise.then(changedKeys => {
                for (const fieldId of fieldIdsWhichAreNotAlreadyLoadedOrLoading) {
                    this._areCellValuesLoadedByFieldId[fieldId] = true;
                    this._pendingCellValuesLoadPromiseByFieldId[fieldId] = undefined;
                }

                for (const key of changedKeys) {
                    this._onChange(key);
                }
            });
        }
        await Promise.all(pendingLoadPromises);
    }

    async _loadCellValuesInFieldIdsAsync(
        fieldIds: Array<FieldId>,
    ): Promise<Array<WatchableRecordStoreKey>> {
        const {
            recordsById: newRecordsById,
        } = await this._airtableInterface.fetchAndSubscribeToCellValuesInFieldsAsync(
            this.tableId,
            fieldIds,
        );

        if (!this._data.recordsById) {
            this._data.recordsById = {};
        }
        const {recordsById: existingRecordsById} = this._data;
        for (const [recordId, newRecordObj] of entries(
            (newRecordsById: {[RecordId]: RecordData}),
        )) {
            if (!has(existingRecordsById, recordId)) {
                existingRecordsById[recordId] = newRecordObj;
            } else {
                const existingRecordObj = existingRecordsById[recordId];
                invariant(
                    existingRecordObj.commentCount === newRecordObj.commentCount,
                    'comment count out of sync',
                );
                invariant(
                    existingRecordObj.createdTime === newRecordObj.createdTime,
                    'created time out of sync',
                );
                if (!existingRecordObj.cellValuesByFieldId) {
                    existingRecordObj.cellValuesByFieldId = {};
                }
                const existingCellValuesByFieldId = existingRecordObj.cellValuesByFieldId;
                for (let i = 0; i < fieldIds.length; i++) {
                    const fieldId = fieldIds[i];
                    existingCellValuesByFieldId[fieldId] = newRecordObj.cellValuesByFieldId
                        ? newRecordObj.cellValuesByFieldId[fieldId]
                        : undefined;
                }
            }
        }

        const changedKeys = fieldIds.map(fieldId => WatchableCellValuesInFieldKeyPrefix + fieldId);
        changedKeys.push(WatchableRecordStoreKeys.records);
        changedKeys.push(WatchableRecordStoreKeys.recordIds);
        changedKeys.push(WatchableRecordStoreKeys.cellValues);
        return changedKeys;
    }

    unloadCellValuesInFieldIds(fieldIds: Array<FieldId>) {
        const fieldIdsWithZeroRetainCount: Array<FieldId> = [];
        for (const fieldId of fieldIds) {
            let fieldRetainCount = this._cellValuesRetainCountByFieldId[fieldId] || 0;
            fieldRetainCount--;

            if (fieldRetainCount < 0) {
                console.log('Field data over-released'); // eslint-disable-line no-console
                fieldRetainCount = 0;
            }
            this._cellValuesRetainCountByFieldId[fieldId] = fieldRetainCount;

            if (fieldRetainCount === 0) {
                fieldIdsWithZeroRetainCount.push(fieldId);
            }
        }
        if (fieldIdsWithZeroRetainCount.length > 0) {
            setTimeout(() => {
                const fieldIdsToUnload = fieldIdsWithZeroRetainCount.filter(fieldId => {
                    return this._cellValuesRetainCountByFieldId[fieldId] === 0;
                });
                if (fieldIdsToUnload.length > 0) {
                    for (const fieldId of fieldIdsToUnload) {
                        this._areCellValuesLoadedByFieldId[fieldId] = false;
                    }
                    this._unloadCellValuesInFieldIds(fieldIdsToUnload);
                }
            }, AbstractModelWithAsyncData.__DATA_UNLOAD_DELAY_MS);
        }
    }

    _unloadCellValuesInFieldIds(fieldIds: Array<FieldId>) {
        this._airtableInterface.unsubscribeFromCellValuesInFields(this.tableId, fieldIds);
        this._afterUnloadDataOrUnloadCellValuesInFieldIds(fieldIds);
    }

    async _loadDataAsync(): Promise<Array<WatchableRecordStoreKey>> {
        const tableData = await this._airtableInterface.fetchAndSubscribeToTableDataAsync(
            this.tableId,
        );
        this._data.recordsById = tableData.recordsById;

        const changedKeys = [
            WatchableRecordStoreKeys.records,
            WatchableRecordStoreKeys.recordIds,
            WatchableRecordStoreKeys.cellValues,
        ];

        for (const fieldId of Object.keys(this._data.fieldsById)) {
            changedKeys.push(WatchableCellValuesInFieldKeyPrefix + fieldId);
        }

        return changedKeys;
    }

    _unloadData() {
        this._airtableInterface.unsubscribeFromTableData(this.tableId);
        this._afterUnloadDataOrUnloadCellValuesInFieldIds();
    }

    _afterUnloadDataOrUnloadCellValuesInFieldIds(unloadedFieldIds?: Array<FieldId>) {
        const areAnyFieldsLoaded =
            this.isDataLoaded ||
            values(this._areCellValuesLoadedByFieldId).some(isLoaded => isLoaded);
        if (!this.isDeleted) {
            if (!areAnyFieldsLoaded) {
                this._data.recordsById = undefined;
            } else if (!this.isDataLoaded) {
                let fieldIdsToClear;
                if (unloadedFieldIds) {
                    fieldIdsToClear = unloadedFieldIds;
                } else {
                    const fieldIds = Object.keys(this._data.fieldsById);
                    fieldIdsToClear = fieldIds.filter(
                        fieldId => !this._areCellValuesLoadedByFieldId[fieldId],
                    );
                }
                const {recordsById} = this._data;
                for (const recordObj of values(recordsById || {})) {
                    for (let i = 0; i < fieldIdsToClear.length; i++) {
                        const fieldId = fieldIdsToClear[i];
                        if (recordObj.cellValuesByFieldId) {
                            recordObj.cellValuesByFieldId[fieldId] = undefined;
                        }
                    }
                }
            }
        }
        if (!areAnyFieldsLoaded) {
            this._recordModelsById = {};
        }
    }

    triggerOnChangeForDirtyPaths(dirtyPaths: Object) {
        if (this.isRecordMetadataLoaded && dirtyPaths.recordsById) {
            const dirtyFieldIdsSet = {};
            const addedRecordIds = [];
            const removedRecordIds = [];
            for (const [recordId, dirtyRecordPaths] of entries(dirtyPaths.recordsById)) {
                if (dirtyRecordPaths._isDirty) {

                    invariant(this._data.recordsById, 'No recordsById');
                    if (has(this._data.recordsById, recordId)) {
                        addedRecordIds.push(recordId);
                    } else {
                        removedRecordIds.push(recordId);

                        const recordModel = this._recordModelsById[recordId];
                        if (recordModel) {
                            delete this._recordModelsById[recordId];
                        }
                    }
                } else {
                    const recordModel = this._recordModelsById[recordId];
                    if (recordModel) {
                        recordModel.__triggerOnChangeForDirtyPaths(dirtyRecordPaths);
                    }
                }

                const {cellValuesByFieldId} = dirtyRecordPaths;
                if (cellValuesByFieldId) {
                    for (const fieldId of Object.keys(cellValuesByFieldId)) {
                        dirtyFieldIdsSet[fieldId] = true;
                    }
                }
            }

            if (addedRecordIds.length > 0 || removedRecordIds.length > 0) {
                this._onChange(WatchableRecordStoreKeys.records, {
                    addedRecordIds,
                    removedRecordIds,
                });

                this._onChange(WatchableRecordStoreKeys.recordIds, {
                    addedRecordIds,
                    removedRecordIds,
                });
            }

            const fieldIds = Object.freeze(Object.keys(dirtyFieldIdsSet));
            const recordIds = Object.freeze(Object.keys(dirtyPaths.recordsById));
            if (fieldIds.length > 0 && recordIds.length > 0) {
                this._onChange(WatchableRecordStoreKeys.cellValues, {
                    recordIds,
                    fieldIds,
                });
            }
            for (const fieldId of fieldIds) {
                this._onChange(WatchableCellValuesInFieldKeyPrefix + fieldId, recordIds, fieldId);
            }
        }
    }
}

export default RecordStore;