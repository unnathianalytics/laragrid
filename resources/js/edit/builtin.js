/**
 * What: Registers the built-in editors (text, number, select, searchselect, date, checkbox) into
 *       the EditorRegistry on import.
 * Why:  Keeps EditorRegistry pure (a map + accessors) and gathers the core registrations in one
 *       place GridCore imports once — the same seam a consuming app uses to register custom editors
 *       (plan §3.8). M4 shipped text/number; M5 adds the picker set against the same seam.
 * When: Imported for side effects by GridCore before constructing an EditorManager.
 */
import { registerEditor } from './EditorRegistry.js';
import TextEditor from './editors/TextEditor.js';
import NumberEditor from './editors/NumberEditor.js';
import SelectEditor from './editors/SelectEditor.js';
import SearchSelectEditor from './editors/SearchSelectEditor.js';
import DateEditor from './editors/DateEditor.js';
import CheckboxInline from './editors/CheckboxInline.js';

registerEditor('text', TextEditor);
registerEditor('number', NumberEditor);
registerEditor('select', SelectEditor);
registerEditor('searchselect', SearchSelectEditor);
registerEditor('date', DateEditor);
registerEditor('checkbox', CheckboxInline);
