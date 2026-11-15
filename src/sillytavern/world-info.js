// world-info.js — SillyTavern's lorebooks: their names (`world_names`, a live binding), the globally selected books
// (`selected_world_info`, a live binding) and the chat metadata key of a chat's book, loading one, the entries in
// activation order, a scan of the books (`checkWorldInfo`) and whether it reads each message with its speaker's name
// (`world_info_include_names`, a live binding), and the World Info settings.
// Re-exports only: the rest of VectFox imports these here, never from SillyTavern (tools/check-host-imports.mjs).
export {
    METADATA_KEY, checkWorldInfo, getSortedEntries, getWorldInfoSettings, loadWorldInfo, selected_world_info, world_info_include_names, world_names,
} from '../../../../../world-info.js';
