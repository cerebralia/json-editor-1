import { Class } from './class'
import { ipValidator } from './validators/ip-validator'
import { $extend, $each } from './utilities'

export const Validator = Class.extend({
  init: function (jsoneditor, schema, options, defaults) {
    this.jsoneditor = jsoneditor
    this.schema = schema || this.jsoneditor.schema
    this.options = options || {}
    this.translate = this.jsoneditor.translate || defaults.translate
    this.defaults = defaults
  },
  fitTest: function (value, givenSchema, weight) {
    weight = typeof weight === 'undefined' ? 10000000 : weight
    const fit = { match: 0, extra: 0 }
    if (typeof value === 'object' && value !== null) {
      // Work on a copy of the schema
      const properties = this._getSchema(givenSchema).properties

      for (const i in properties) {
        if (!properties.hasOwnProperty(i)) {
          fit.extra += weight
          continue
        }
        if (typeof value[i] === 'object' && typeof properties[i] === 'object' && typeof properties[i].properties === 'object') {
          const result = this.fitTest(value[i], properties[i], weight / 100)
          fit.match += result.match
          fit.extra += result.extra
        }
        if (typeof value[i] !== 'undefined') {
          fit.match += weight
        }
      }
    }
    return fit
  },
  _getSchema: function (schema) {
    return typeof schema === 'undefined' ? $extend({}, this.jsoneditor.expandRefs(this.schema)) : schema
  },
  validate: function (value) {
    return this._validateSchema(this.schema, value)
  },
  _validateSchema: function (schema, value, path) {
    const self = this
    const errors = []
    path = path || 'root'

    // Work on a copy of the schema
    schema = $extend({}, this.jsoneditor.expandRefs(schema))

    /*
     * Type Agnostic Validation
     */
    // Version 3 `required` and `required_by_default`
    if (typeof value === 'undefined') {
      return this._validateV3Required(schema, value, path)
    }

    Object.keys(schema).forEach(key => {
      if (this._validateSubSchema[key]) {
        errors.push(...this._validateSubSchema[key].call(self, schema, value, path))
      }
    })

    /*
     * Type Specific Validation
     */
    errors.push(...this._validateByValueType(schema, value, path))

    if (schema.links) {
      for (let m = 0; m < schema.links.length; m++) {
        if (schema.links[m].rel && schema.links[m].rel.toLowerCase() === 'describedby') {
          schema = this._expandSchemaLink(schema, m)
          errors.push(...this._validateSchema(schema, value, path, this.translate))
        }
      }
    }

    // date, time and datetime-local validation
    if (['date', 'time', 'datetime-local'].indexOf(schema.format) !== -1) {
      errors.push(...this._validateDateTimeSubSchema.call(self, schema, value, path))
    }

    // custom validator
    errors.push(...this._validateCustomValidator(schema, value, path))

    // Remove duplicate errors and add "errorcount" property
    return this._removeDuplicateErrors(errors)
  },
  _expandSchemaLink: function (schema, m) {
    const href = schema.links[m].href
    const data = this.jsoneditor.root.getValue()
    // var template = new UriTemplate(href); //preprocessURI(href));
    // var ref = template.fillFromObject(data);
    const template = this.jsoneditor.compileTemplate(href, this.jsoneditor.template)
    const ref = document.location.origin + document.location.pathname + template(data)

    schema.links = schema.links.slice(0, m).concat(schema.links.slice(m + 1))
    return $extend({}, schema, this.jsoneditor.refs[ref])
  },
  _validateV3Required: function (schema, value, path) {
    const errors = []
    if ((typeof schema.required !== 'undefined' && schema.required === true) || (typeof schema.required === 'undefined' && this.jsoneditor.options.required_by_default === true)) {
      errors.push({
        path: path,
        property: 'required',
        message: this.translate('error_notset')
      })
    }
    return errors
  },
  _validateSubSchema: {
    enum: function (schema, value, path) {
      const stringified = JSON.stringify(value)
      const errors = []
      const valid = schema.enum.some(e => stringified === JSON.stringify(e))
      if (!valid) {
        errors.push({
          path: path,
          property: 'enum',
          message: this.translate('error_enum')
        })
      }
      return errors
    },
    extends: function (schema, value, path) {
      const validate = (errors, e) => {
        errors.push(...this._validateSchema(e, value, path))
        return errors
      }
      return schema.extends.reduce(validate, [])
    },
    allOf: function (schema, value, path) {
      const validate = (errors, e) => {
        errors.push(...this._validateSchema(e, value, path))
        return errors
      }
      return schema.allOf.reduce(validate, [])
    },
    anyOf: function (schema, value, path) {
      const errors = []
      const valid = schema.anyOf.some(e => !this._validateSchema(e, value, path).length)
      if (!valid) {
        errors.push({
          path: path,
          property: 'anyOf',
          message: this.translate('error_anyOf')
        })
      }
      return errors
    },
    oneOf: function (schema, value, path) {
      let valid = 0
      const oneofErrors = []
      const errors = []
      schema.oneOf.forEach((o, i) => {
        // Set the error paths to be path.oneOf[i].rest.of.path
        const tmp = this._validateSchema(o, value, path)
        if (!tmp.length) {
          valid++
        }

        tmp.forEach(e => {
          e.path = `${path}.oneOf[${i}]${e.path.substr(path.length)}`
        })
        oneofErrors.push(...tmp)
      })
      if (valid !== 1) {
        errors.push({
          path: path,
          property: 'oneOf',
          message: this.translate('error_oneOf', [valid])
        })
        errors.push(...oneofErrors)
      }
      return errors
    },
    not: function (schema, value, path) {
      const errors = []
      if (!this._validateSchema(schema.not, value, path).length) {
        errors.push({
          path: path,
          property: 'not',
          message: this.translate('error_not')
        })
      }
      return errors
    },
    type: function (schema, value, path) {
      const errors = []
      let valid
      // Union type
      if (Array.isArray(schema.type)) {
        valid = schema.type.some(e => this._checkType(e, value))
        if (!valid) {
          errors.push({
            path: path,
            property: 'type',
            message: this.translate('error_type_union')
          })
        }
      } else {
      // Simple type
        if (['date', 'time', 'datetime-local'].indexOf(schema.format) !== -1 && schema.type === 'integer') {
          // Hack to get validator to validate as string even if value is integer
          // As validation of 'date', 'time', 'datetime-local' is done in separate validator
          if (!this._checkType('string', '' + value)) {
            errors.push({
              path: path,
              property: 'type',
              message: this.translate('error_type', [schema.format])
            })
          }
        } else if (!this._checkType(schema.type, value)) {
          errors.push({
            path: path,
            property: 'type',
            message: this.translate('error_type', [schema.type])
          })
        }
      }
      return errors
    },
    disallow: function (schema, value, path) {
      const errors = []
      // Union type
      if (Array.isArray(schema.disallow)) {
        const invalid = schema.disallow.some(e => this._checkType(e, value))
        if (invalid) {
          errors.push({
            path: path,
            property: 'disallow',
            message: this.translate('error_disallow_union')
          })
        }
      } else {
        // Simple type
        if (this._checkType(schema.disallow, value)) {
          errors.push({
            path: path,
            property: 'disallow',
            message: this.translate('error_disallow', [schema.disallow])
          })
        }
      }
      return errors
    }
  },
  _validateByValueType: function (schema, value, path) {
    const errors = []
    const self = this
    if (value === null) return errors
    // Number Specific Validation
    if (typeof value === 'number') {
      // `multipleOf` and `divisibleBy`
      // `maximum`
      // `minimum`
      Object.keys(schema).forEach(key => {
        if (this._validateNumberSubSchema[key]) {
          errors.push(...this._validateNumberSubSchema[key].call(self, schema, value, path))
        }
      })
    // String specific validation
    } else if (typeof value === 'string') {
      // `maxLength`
      // `minLength`
      // `pattern`
      Object.keys(schema).forEach(key => {
        if (this._validateStringSubSchema[key]) {
          errors.push(...this._validateStringSubSchema[key].call(self, schema, value, path))
        }
      })
    // Array specific validation
    } else if (Array.isArray(value)) {
      // `items` and `additionalItems`
      // `maxItems`
      // `minItems`
      // `uniqueItems`
      Object.keys(schema).forEach(key => {
        if (this._validateArraySubSchema[key]) {
          errors.push(...this._validateArraySubSchema[key].call(self, schema, value, path))
        }
      })
    // Object specific validation
    } else if (typeof value === 'object') {
      const validatedProperties = {}
      // `maxProperties`
      // `minProperties`
      //  Version 4 `required`
      // `properties`
      // `patternProperties`
      Object.keys(schema).forEach(key => {
        if (this._validateObjectSubSchema[key]) {
          errors.push(...this._validateObjectSubSchema[key].call(self, schema, value, path, validatedProperties))
        }
      })

      // The no_additional_properties option currently doesn't work with extended schemas that use oneOf or anyOf
      if (typeof schema.additionalProperties === 'undefined' && this.jsoneditor.options.no_additional_properties && !schema.oneOf && !schema.anyOf) {
        schema.additionalProperties = false
      }

      // `additionalProperties`
      // `dependencies`
      Object.keys(schema).forEach(key => {
        if (typeof this._validateObjectSubSchema2[key] !== 'undefined') {
          errors.push(...this._validateObjectSubSchema2[key].call(self, schema, value, path, validatedProperties))
        }
      })
    }
    return errors
  },
  _validateNumberSubSchema: {
    multipleOf: function (schema, value, path) { return this._validateNumberSubSchemaMultipleDivisible(schema, value, path) },
    divisibleBy: function (schema, value, path) { return this._validateNumberSubSchemaMultipleDivisible(schema, value, path) },
    maximum: function (schema, value, path) {
      // Vanilla JS, prone to floating point rounding errors (e.g. .999999999999999 == 1)
      let valid = schema.exclusiveMaximum ? (value < schema.maximum) : (value <= schema.maximum)
      const errors = []

      // Use math.js is available
      if (window.math) {
        valid = window.math[schema.exclusiveMaximum ? 'smaller' : 'smallerEq'](
          window.math.bignumber(value),
          window.math.bignumber(schema.maximum)
        )
      } else if (window.Decimal) {
        // Use Decimal.js if available
        valid = (new window.Decimal(value))[schema.exclusiveMaximum ? 'lt' : 'lte'](new window.Decimal(schema.maximum))
      }

      if (!valid) {
        errors.push({
          path: path,
          property: 'maximum',
          message: this.translate(
            (schema.exclusiveMaximum ? 'error_maximum_excl' : 'error_maximum_incl'),
            [schema.maximum]
          )
        })
      }
      return errors
    },
    minimum: function (schema, value, path) {
      // Vanilla JS, prone to floating point rounding errors (e.g. .999999999999999 == 1)
      let valid = schema.exclusiveMinimum ? (value > schema.minimum) : (value >= schema.minimum)
      const errors = []

      // Use math.js is available
      if (window.math) {
        valid = window.math[schema.exclusiveMinimum ? 'larger' : 'largerEq'](
          window.math.bignumber(value),
          window.math.bignumber(schema.minimum)
        )
        // Use Decimal.js if available
      } else if (window.Decimal) {
        valid = (new window.Decimal(value))[schema.exclusiveMinimum ? 'gt' : 'gte'](new window.Decimal(schema.minimum))
      }

      if (!valid) {
        errors.push({
          path: path,
          property: 'minimum',
          message: this.translate(
            (schema.exclusiveMinimum ? 'error_minimum_excl' : 'error_minimum_incl'),
            [schema.minimum]
          )
        })
      }
      return errors
    }
  },
  _validateNumberSubSchemaMultipleDivisible: function (schema, value, path) {
    const divisor = schema.multipleOf || schema.divisibleBy
    const errors = []
    // Vanilla JS, prone to floating point rounding errors (e.g. 1.14 / .01 == 113.99999)
    let valid = (value / divisor === Math.floor(value / divisor))

    // Use math.js is available
    if (window.math) {
      valid = window.math.mod(window.math.bignumber(value), window.math.bignumber(divisor)).equals(0)
    } else if (window.Decimal) {
      // Use decimal.js is available
      valid = (new window.Decimal(value)).mod(new window.Decimal(divisor)).equals(0)
    }

    if (!valid) {
      errors.push({
        path: path,
        property: schema.multipleOf ? 'multipleOf' : 'divisibleBy',
        message: this.translate('error_multipleOf', [divisor])
      })
    }
    return errors
  },
  _validateStringSubSchema: {
    maxLength: function (schema, value, path) {
      const errors = []
      if ((value + '').length > schema.maxLength) {
        errors.push({
          path: path,
          property: 'maxLength',
          message: this.translate('error_maxLength', [schema.maxLength])
        })
      }
      return errors
    },
    // `minLength`
    minLength: function (schema, value, path) {
      const errors = []
      if ((value + '').length < schema.minLength) {
        errors.push({
          path: path,
          property: 'minLength',
          message: this.translate((schema.minLength === 1 ? 'error_notempty' : 'error_minLength'), [schema.minLength])
        })
      }
      return errors
    },
    // `pattern`
    pattern: function (schema, value, path) {
      const errors = []
      if (!(new RegExp(schema.pattern)).test(value)) {
        errors.push({
          path: path,
          property: 'pattern',
          message: (schema.options && schema.options.patternmessage) ? schema.options.patternmessage : this.translate('error_pattern', [schema.pattern])
        })
      }
      return errors
    }
  },
  _validateArraySubSchema: {
    items: function (schema, value, path) {
      const errors = []
      if (Array.isArray(schema.items)) {
        for (let i = 0; i < value.length; i++) {
          // If this item has a specific schema tied to it
          // Validate against it
          if (schema.items[i]) {
            errors.push(...this._validateSchema(schema.items[i], value[i], path + '.' + i))
          // If all additional items are allowed
          } else if (schema.additionalItems === true) {
            break
          // If additional items is a schema
          // TODO: Incompatibility between version 3 and 4 of the spec
          } else if (schema.additionalItems) {
            errors.push(...this._validateSchema(schema.additionalItems, value[i], path + '.' + i))
          // If no additional items are allowed
          } else if (schema.additionalItems === false) {
            errors.push({
              path: path,
              property: 'additionalItems',
              message: this.translate('error_additionalItems')
            })
            break
          // Default for `additionalItems` is an empty schema
          } else {
            break
          }
        }
      // `items` is a schema
      } else {
        // Each item in the array must validate against the schema
        value.forEach((e, i) => {
          errors.push(...this._validateSchema(schema.items, e, path + '.' + i))
        })
      }
      return errors
    },
    maxItems: function (schema, value, path) {
      const errors = []
      if (value.length > schema.maxItems) {
        errors.push({
          path: path,
          property: 'maxItems',
          message: this.translate('error_maxItems', [schema.maxItems])
        })
      }
      return errors
    },
    minItems: function (schema, value, path) {
      const errors = []
      if (value.length < schema.minItems) {
        errors.push({
          path: path,
          property: 'minItems',
          message: this.translate('error_minItems', [schema.minItems])
        })
      }
      return errors
    },
    uniqueItems: function (schema, value, path) {
      const errors = []
      const seen = {}
      for (let i = 0; i < value.length; i++) {
        const valid = JSON.stringify(value[i])
        if (seen[valid]) {
          errors.push({
            path: path,
            property: 'uniqueItems',
            message: this.translate('error_uniqueItems')
          })
          break
        }
        seen[valid] = true
      }
      return errors
    }
  },
  _validateObjectSubSchema: {
    maxProperties: function (schema, value, path) {
      const errors = []
      if (Object.keys(value).length > schema.maxProperties) {
        errors.push({
          path: path,
          property: 'maxProperties',
          message: this.translate('error_maxProperties', [schema.maxProperties])
        })
      }
      return errors
    },
    minProperties: function (schema, value, path) {
      const errors = []
      if (Object.keys(value).length < schema.minProperties) {
        errors.push({
          path: path,
          property: 'minProperties',
          message: this.translate('error_minProperties', [schema.minProperties])
        })
      }
      return errors
    },
    required: function (schema, value, path) {
      const errors = []
      if (Array.isArray(schema.required)) {
        schema.required.forEach(e => {
          if (typeof value[e] === 'undefined') {
            var editor = this.jsoneditor.getEditor(path + '.' + e)
            // Ignore required error if editor is of type "button" or "info"
            if (editor && ['button', 'info'].indexOf(editor.schema.format || editor.schema.type) !== -1) return
            errors.push({
              path: path,
              property: 'required',
              message: this.translate('error_required', [e])
            })
          }
        })
      }
      return errors
    },
    properties: function (schema, value, path, validatedProperties) {
      const errors = []
      Object.entries(schema.properties).forEach(([key, prop]) => {
        validatedProperties[key] = true
        errors.push(...this._validateSchema(prop, value[key], path + '.' + key))
      })
      return errors
    },
    patternProperties: function (schema, value, path, validatedProperties) {
      const errors = []
      Object.entries(schema.patternProperties).forEach(([i, prop]) => {
        const regex = new RegExp(i)
        // Check which properties match
        Object.entries(value).forEach(([j, v]) => {
          if (regex.test(j)) {
            validatedProperties[j] = true
            errors.push(...this._validateSchema(prop, v, path + '.' + j))
          }
        })
      })
      return errors
    }
  },
  _validateObjectSubSchema2: {
    additionalProperties: function (schema, value, path, validatedProperties) {
      const errors = []
      for (let i in value) {
        if (!value.hasOwnProperty(i)) continue
        if (!validatedProperties[i]) {
          // No extra properties allowed
          if (!schema.additionalProperties) {
            errors.push({
              path: path,
              property: 'additionalProperties',
              message: this.translate('error_additional_properties', [i])
            })
            break
          // Allowed
          } else if (schema.additionalProperties === true) {
            break
          // Must match schema
          // TODO: incompatibility between version 3 and 4 of the spec
          } else {
            errors.push(...this._validateSchema(schema.additionalProperties, value[i], path + '.' + i))
          }
        }
      }
      return errors
    },
    dependencies: function (schema, value, path) {
      const errors = []
      Object.entries(schema.dependencies).forEach(([i, dep]) => {
        // Doesn't need to meet the dependency
        if (typeof value[i] === 'undefined') return

        // Property dependency
        if (Array.isArray(dep)) {
          dep.forEach(d => {
            if (typeof value[d] === 'undefined') {
              errors.push({
                path: path,
                property: 'dependencies',
                message: this.translate('error_dependency', [d])
              })
            }
          })
        // Schema dependency
        } else {
          errors.push(...this._validateSchema(dep, value, path))
        }
      })
      return errors
    }
  },
  _validateDateTimeSubSchema: function (schema, value, path) {
    const errors = []
    const _validateInteger = (schema, value, path) => {
      const errors = []
      // The value is a timestamp
      if (value * 1 < 1) {
        // If value is less than 1, then it's an invalid epoch date before 00:00:00 UTC Thursday, 1 January 1970
        errors.push({
          path: path,
          property: 'format',
          message: this.translate('error_invalid_epoch')
        })
      } else if (value !== Math.abs(parseInt(value))) {
        // not much to check for, so we assume value is ok if it's a positive number
        errors.push({
          path: path,
          property: 'format',
          message: this.translate('error_' + schema.format.replace(/-/g, '_'), [dateFormat])
        })
      }
      return errors
    }
    const _validateFlatPicker = (schema, value, path, editor) => {
      const errors = []
      if (value !== '') {
        let compareValue
        if (editor.flatpickr.config.mode !== 'single') {
          const seperator = editor.flatpickr.config.mode === 'range' ? editor.flatpickr.l10n.rangeSeparator : ', '
          const selectedDates = editor.flatpickr.selectedDates.map(val =>
            editor.flatpickr.formatDate(val, editor.flatpickr.config.dateFormat)
          )
          compareValue = selectedDates.join(seperator)
        }

        try {
          if (compareValue) {
            // Not the best validation method, but range and multiple mode are special
            // Optimal solution would be if it is possible to change the return format from string/integer to array
            if (compareValue !== value) throw new Error(editor.flatpickr.config.mode + ' mismatch')
          } else if (editor.flatpickr.formatDate(editor.flatpickr.parseDate(value, editor.flatpickr.config.dateFormat), editor.flatpickr.config.dateFormat) !== value) {
            throw new Error('mismatch')
          }
        } catch (err) {
          const errorDateFormat = editor.flatpickr.config.errorDateFormat !== undefined ? editor.flatpickr.config.errorDateFormat : editor.flatpickr.config.dateFormat
          errors.push({
            path: path,
            property: 'format',
            message: this.translate('error_' + editor.format.replace(/-/g, '_'), [errorDateFormat])
          })
        }
      }
      return errors
    }

    const validatorRx = {
      'date': /^(\d{4}\D\d{2}\D\d{2})?$/,
      'time': /^(\d{2}:\d{2}(?::\d{2})?)?$/,
      'datetime-local': /^(\d{4}\D\d{2}\D\d{2}[ T]\d{2}:\d{2}(?::\d{2})?)?$/
    }
    const format = {
      'date': '"YYYY-MM-DD"',
      'time': '"HH:MM"',
      'datetime-local': '"YYYY-MM-DD HH:MM"'
    }

    const editor = this.jsoneditor.getEditor(path)
    const dateFormat = (editor && editor.flatpickr) ? editor.flatpickr.config.dateFormat : format[schema.format]

    if (schema.type === 'integer') {
      errors.push(..._validateInteger(schema, value, path))
    } else if (!editor || !editor.flatpickr) {
      // Standard string input, without flatpickr
      if (!validatorRx[schema.format].test(value)) {
        errors.push({
          path: path,
          property: 'format',
          message: this.translate('error_' + schema.format.replace(/-/g, '_'), [dateFormat])
        })
      }
    } else if (editor) {
      // Flatpickr validation
      errors.push(..._validateFlatPicker(schema, value, path, editor))
    }
    return errors
  },
  _validateCustomValidator: function (schema, value, path) {
    const errors = []
    const self = this
    // Internal validators using the custom validator format
    errors.push(...ipValidator.call(self, schema, value, path, self.translate))

    // Custom type validation (global)
    $each(self.defaults.custom_validators, function (i, validator) {
      errors.push(...validator.call(self, schema, value, path))
    })
    // Custom type validation (instance specific)
    if (this.options.custom_validators) {
      $each(this.options.custom_validators, function (i, validator) {
        errors.push(...validator.call(self, schema, value, path))
      })
    }
    return errors
  },
  _removeDuplicateErrors: function (errors) {
    return errors.reduce((err, obj) => {
      let first = true
      if (!err) err = []
      err.forEach(a => {
        if (a.message === obj.message && a.path === obj.path && a.property === obj.property) {
          a.errorcount++
          first = false
        }
      })
      if (first) {
        obj.errorcount = 1
        err.push(obj)
      }
      return err
    }, [])
  },
  _checkType: function (type, value) {
    const types = {
      string: value => typeof value === 'string',
      number: value => typeof value === 'number',
      integer: value => typeof value === 'number' && value === Math.floor(value),
      boolean: value => typeof value === 'boolean',
      array: value => Array.isArray(value),
      object: value => value !== null && !(Array.isArray(value)) && typeof value === 'object',
      null: value => value === null
    }
    // Simple types
    if (typeof type === 'string') {
      if (types[type]) {
        return types[type](value)
      } else return true
    // Schema
    } else {
      return !this._validateSchema(type, value).length
    }
  }
})
