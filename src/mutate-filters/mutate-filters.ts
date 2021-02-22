import { InputType } from '../types';
import { RemoveDuplicate } from '../utils';
import { combineScalarFilters } from './combine-scalar-filters';
import { noAtomicNumberOperations } from './no-atomic-number-operations';
import { removeDuplicateTypes } from './remove-duplicate-types';
import { renameZooTypes } from './rename-zoo-types';

type MutateFiltersOptions = {
    atomicNumberOperations?: boolean;
    combineScalarFilters?: boolean;
    renameZooTypes?: boolean;
    removeDuplicateTypes: RemoveDuplicate;
};

export function mutateFilters(inputTypes: InputType[], options: MutateFiltersOptions) {
    if (options.combineScalarFilters) {
        inputTypes = inputTypes.map(combineScalarFilters(inputTypes));
    }
    if (!options.atomicNumberOperations) {
        inputTypes = inputTypes.filter(noAtomicNumberOperations());
    }
    if (options.renameZooTypes) {
        inputTypes = inputTypes.map(renameZooTypes(inputTypes));
    }

    return inputTypes;
}
