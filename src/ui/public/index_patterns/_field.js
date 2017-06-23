import ObjDefine from 'ui/utils/ObjDefine';
import IndexPatternsFieldFormatFieldFormatProvider from 'ui/index_patterns/_field_format/FieldFormat';
import IndexPatternsFieldTypesProvider from 'ui/index_patterns/_field_types';
import RegistryFieldFormatsProvider from 'ui/registry/field_formats';
import { filter } from 'lodash';

export default function FieldObjectProvider(Private, shortDotsFilter, $rootScope, createNotifier) {
  const notify = createNotifier({ location: 'IndexPattern Field' });
  const FieldFormat = Private(IndexPatternsFieldFormatFieldFormatProvider);
  const fieldTypes = Private(IndexPatternsFieldTypesProvider);
  const fieldFormats = Private(RegistryFieldFormatsProvider);

  function Field(indexPattern, spec) {
    // unwrap old instances of Field
    if (spec instanceof Field) spec = spec.$$spec;

    // constuct this object using ObjDefine class, which
    // extends the Field.prototype but gets it's properties
    // defined using the logic below
    const obj = new ObjDefine(spec, Field.prototype);

    if (spec.name === '_source') {
      spec.type = '_source';
    }

    // find the type for this field, fallback to unknown type
    let type = fieldTypes.byName[spec.type];
    if (spec.type && !type) {
      notify.error(
        'Unknown field type "' + spec.type + '"' +
        ' for field "' + spec.name + '"' +
        ' in indexPattern "' + indexPattern.id + '"'
      );
    }

    if (!type) type = fieldTypes.byName.unknown;

    let format = spec.format;
    if (!format || !(format instanceof FieldFormat)) {
      format = indexPattern.fieldFormatMap[spec.name] || fieldFormats.getDefaultInstance(spec.type);
    }

    const indexed = !!spec.indexed;
    const scripted = !!spec.scripted;
    const sortable = spec.name === '_score' || ((indexed || scripted) && type.sortable);
    const bucketable = indexed || scripted;
    const filterable = spec.name === '_id' || scripted || (indexed && type.filterable);

    obj.fact('name');
    obj.fact('type');
    obj.writ('count', spec.count || 0);

    // scripted objs
    obj.fact('scripted', scripted);
    obj.writ('script', scripted ? spec.script : null);
    obj.writ('lang', scripted ? (spec.lang || 'expression') : null);

    // mapping info
    obj.fact('indexed', indexed);
    obj.fact('analyzed', !!spec.analyzed);
    obj.fact('doc_values', !!spec.doc_values);

    // usage flags, read-only and won't be saved
    obj.comp('format', format);
    obj.comp('sortable', sortable);
    obj.comp('bucketable', bucketable);
    obj.comp('filterable', filterable);

    // computed values
    obj.comp('indexPattern', indexPattern);
    obj.comp('displayName', shortDotsFilter(spec.name));
    obj.comp('$$spec', spec);

    // kibi: add path sequence and multifields properties
    obj.comp('path', indexPattern.paths && indexPattern.paths[spec.name] || []);

    const multifields = filter(indexPattern.fields, (f) => {
      const nameMatched = f.name.indexOf(spec.name + '.') === 0;
      // if name starts with same prefix + dot
      // do another check to make sure that the field is a subfield
      // and NOT just another field with a "dot" in it
      return nameMatched && indexPattern.kibiPathsFetched && !Boolean(indexPattern.paths[f.name]);
    });
    obj.comp('multifields', multifields);
    // kibi: end

    return obj.create();
  }

  Field.prototype.routes = {
    edit: '/settings/indices/{{indexPattern.id}}/field/{{name}}'
  };

  return Field;
}
