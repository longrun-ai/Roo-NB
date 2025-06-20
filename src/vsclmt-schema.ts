import { z } from 'zod';
import { Logger } from './errors';

/**
 * Enhanced interface for JSON Schema used by VS Code Language Model Tools.
 * Supports all common JSON Schema properties used in VS Code extension manifests.
 * 
 * Based on JSON Schema Draft 4-7 specification with VS Code specific extensions.
 */
export interface VSCodeLMJsonSchema {
    // Basic type information
    type?: string | string[];  // Can be array for union types
    const?: any;  // JSON Schema Draft 6+ constant value

    // Enum and value constraints
    enum?: any[];  // Can contain mixed types (string, number, boolean, null)

    // Object schema properties
    properties?: Record<string, VSCodeLMJsonSchema>;
    required?: string[];
    additionalProperties?: boolean | VSCodeLMJsonSchema;
    minProperties?: number;
    maxProperties?: number;

    // Array schema properties
    items?: VSCodeLMJsonSchema | VSCodeLMJsonSchema[];  // Can be array for tuples
    minItems?: number;
    maxItems?: number;
    uniqueItems?: boolean;

    // String constraints
    minLength?: number;
    maxLength?: number;
    pattern?: string;  // Regular expression pattern
    format?: string;   // String format (email, uri, uuid, etc.)

    // Number/integer constraints
    minimum?: number;
    maximum?: number;
    exclusiveMinimum?: number | boolean;  // Draft 4 uses boolean, Draft 6+ uses number
    exclusiveMaximum?: number | boolean;  // Draft 4 uses boolean, Draft 6+ uses number
    multipleOf?: number;

    // VS Code and extension properties
    default?: any;
    description?: string;
    title?: string;
    examples?: any[];

    // Allow additional properties for forward compatibility
    [key: string]: any;
}

/**
 * Converts VS Code Language Model JSON Schema to Zod schema with comprehensive edge case handling.
 * 
 * VS Code supports JSON Schema Draft 4-7 with limited support for 2019-09 and 2020-12.
 * This function handles the subset of JSON Schema used by VS Code Language Model Tools.
 * 
 * @param jsonSchema - JSON Schema from package.json languageModelTools inputSchema
 * @returns Zod schema for runtime validation
 * 
 * @see https://code.visualstudio.com/api/extension-guides/tools
 * @see https://code.visualstudio.com/docs/languages/json
 */
export function vsclmJsonSchemaToZod(jsonSchema: VSCodeLMJsonSchema): z.ZodTypeAny {
    // EDGE CASE: Handle null, undefined, or non-object input
    if (!jsonSchema || typeof jsonSchema !== 'object') {
        Logger.warn('Invalid schema input - not an object', { schema: jsonSchema });
        return z.unknown();
    }

    // EDGE CASE: Handle const values (JSON Schema Draft 6+)
    // const takes precedence over type and enum
    if ('const' in jsonSchema) {
        Logger.debug('Converting const value to literal', { const: jsonSchema.const });
        return z.literal(jsonSchema.const);
    }

    // EDGE CASE: Handle enum with comprehensive validation
    if (jsonSchema.enum !== undefined) {
        return handleEnumSchema(jsonSchema.enum);
    }

    // EDGE CASE: Handle union types (multiple types in array)
    // Example: { "type": ["string", "number"] }
    if (Array.isArray(jsonSchema.type)) {
        Logger.debug('Converting union type schema', { types: jsonSchema.type });
        const schemas = jsonSchema.type.map(type =>
            vsclmJsonSchemaToZod({ ...jsonSchema, type })
        );
        // Ensure we have at least 2 schemas for union (TypeScript requirement)
        return schemas.length >= 2 ? z.union(schemas as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]) : schemas[0];
    }

    // EDGE CASE: Handle missing type field
    // When no type is specified, try to infer from other properties
    if (!jsonSchema.type) {
        return inferTypeFromProperties(jsonSchema);
    }

    // Handle standard types with constraints
    switch (jsonSchema.type) {
        case 'string':
            return handleStringSchema(jsonSchema);

        case 'number':
        case 'integer':
            return handleNumberSchema(jsonSchema);

        case 'boolean':
            return z.boolean();

        case 'array':
            return handleArraySchema(jsonSchema);

        case 'object':
            return handleObjectSchema(jsonSchema);

        case 'null':
            return z.null();

        default:
            Logger.warn('Unknown schema type, falling back to unknown', { type: jsonSchema.type });
            return z.unknown();
    }
}

/**
 * Handles enum schema conversion with comprehensive edge case validation.
 * 
 * Edge cases handled:
 * - Empty enum array
 * - Non-array enum values
 * - Single-value enums
 * - Mixed-type enums (string, number, boolean, null)
 * - Invalid enum values
 */
function handleEnumSchema(enumValues: any): z.ZodTypeAny {
    // EDGE CASE: Non-array enum value
    if (!Array.isArray(enumValues)) {
        Logger.warn('Enum must be an array, falling back to unknown', { enum: enumValues });
        return z.unknown();
    }

    // EDGE CASE: Empty enum array
    if (enumValues.length === 0) {
        Logger.warn('Empty enum array, returning never type');
        return z.never(); // No valid values
    }

    // EDGE CASE: Single-value enum
    if (enumValues.length === 1) {
        Logger.debug('Single-value enum converted to literal', { value: enumValues[0] });
        return z.literal(enumValues[0]);
    }

    // Check if all enum values are strings (Zod enum requirement)
    const allStrings = enumValues.every(val => typeof val === 'string');

    if (allStrings) {
        // Standard string enum
        Logger.debug('Converting string enum', { values: enumValues });
        return z.enum(enumValues as [string, ...string[]]);
    } else {
        // EDGE CASE: Mixed-type enum (string, number, boolean, null)
        // Use union of literals instead of z.enum()
        Logger.debug('Converting mixed-type enum to union of literals', { values: enumValues });
        const literals = enumValues.map((val: any) => z.literal(val));
        // Ensure we have at least 2 literals for union (TypeScript requirement)
        return literals.length >= 2 ? z.union(literals as [z.ZodLiteral<any>, z.ZodLiteral<any>, ...z.ZodLiteral<any>[]]) : literals[0];
    }
}

/**
 * Attempts to infer schema type from other properties when type field is missing.
 * 
 * Inference rules:
 * - Has properties/required -> object
 * - Has items -> array
 * - Has string constraints (minLength, maxLength, pattern) -> string
 * - Has number constraints (minimum, maximum, multipleOf) -> number
 * - Falls back to unknown
 */
function inferTypeFromProperties(jsonSchema: VSCodeLMJsonSchema): z.ZodTypeAny {
    Logger.debug('Type field missing, attempting to infer from properties');

    // Infer object type
    if (jsonSchema.properties || jsonSchema.required || jsonSchema.additionalProperties !== undefined) {
        Logger.debug('Inferred object type from properties/required');
        return handleObjectSchema({ ...jsonSchema, type: 'object' });
    }

    // Infer array type
    if (jsonSchema.items) {
        Logger.debug('Inferred array type from items property');
        return handleArraySchema({ ...jsonSchema, type: 'array' });
    }

    // Infer string type
    if (jsonSchema.minLength !== undefined ||
        jsonSchema.maxLength !== undefined ||
        jsonSchema.pattern !== undefined) {
        Logger.debug('Inferred string type from string constraints');
        return handleStringSchema({ ...jsonSchema, type: 'string' });
    }

    // Infer number type
    if (jsonSchema.minimum !== undefined ||
        jsonSchema.maximum !== undefined ||
        jsonSchema.multipleOf !== undefined ||
        jsonSchema.exclusiveMinimum !== undefined ||
        jsonSchema.exclusiveMaximum !== undefined) {
        Logger.debug('Inferred number type from numeric constraints');
        return handleNumberSchema({ ...jsonSchema, type: 'number' });
    }

    // EDGE CASE: Cannot infer type
    Logger.warn('Cannot infer type from schema properties, falling back to unknown');
    return z.unknown();
}

/**
 * Handles string schema with comprehensive constraint support.
 * 
 * Constraints supported:
 * - minLength, maxLength
 * - pattern (regex)
 * - format (basic validation)
 */
function handleStringSchema(jsonSchema: VSCodeLMJsonSchema): z.ZodString {
    let stringSchema = z.string();

    // Apply length constraints
    if (typeof jsonSchema.minLength === 'number' && jsonSchema.minLength >= 0) {
        stringSchema = stringSchema.min(jsonSchema.minLength);
        Logger.debug('Applied minLength constraint', { minLength: jsonSchema.minLength });
    }

    if (typeof jsonSchema.maxLength === 'number' && jsonSchema.maxLength >= 0) {
        stringSchema = stringSchema.max(jsonSchema.maxLength);
        Logger.debug('Applied maxLength constraint', { maxLength: jsonSchema.maxLength });
    }

    // Apply pattern constraint (regex)
    if (typeof jsonSchema.pattern === 'string') {
        try {
            const regex = new RegExp(jsonSchema.pattern);
            stringSchema = stringSchema.regex(regex);
            Logger.debug('Applied pattern constraint', { pattern: jsonSchema.pattern });
        } catch (error) {
            Logger.warn('Invalid regex pattern, skipping constraint', {
                pattern: jsonSchema.pattern,
                error
            });
        }
    }

    // ENHANCEMENT: Basic format validation
    if (typeof jsonSchema.format === 'string') {
        switch (jsonSchema.format) {
            case 'email':
                stringSchema = stringSchema.email();
                break;
            case 'uri':
            case 'url':
                stringSchema = stringSchema.url();
                break;
            case 'uuid':
                stringSchema = stringSchema.uuid();
                break;
            // Note: More formats could be added here
            default:
                Logger.debug('Unsupported format, skipping validation', { format: jsonSchema.format });
        }
    }

    return stringSchema;
}

/**
 * Handles number/integer schema with comprehensive constraint support.
 * 
 * Constraints supported:
 * - minimum, maximum (inclusive bounds)
 * - exclusiveMinimum, exclusiveMaximum (exclusive bounds)
 * - multipleOf
 * - integer validation
 */
function handleNumberSchema(jsonSchema: VSCodeLMJsonSchema): z.ZodNumber {
    let numSchema = z.number();

    // Apply integer constraint
    if (jsonSchema.type === 'integer') {
        numSchema = numSchema.int();
        Logger.debug('Applied integer constraint');
    }

    // Apply inclusive bounds
    if (typeof jsonSchema.minimum === 'number' && isFinite(jsonSchema.minimum)) {
        numSchema = numSchema.min(jsonSchema.minimum);
        Logger.debug('Applied minimum constraint', { minimum: jsonSchema.minimum });
    }

    if (typeof jsonSchema.maximum === 'number' && isFinite(jsonSchema.maximum)) {
        numSchema = numSchema.max(jsonSchema.maximum);
        Logger.debug('Applied maximum constraint', { maximum: jsonSchema.maximum });
    }

    // ENHANCEMENT: Apply exclusive bounds (JSON Schema Draft 6+)
    if (typeof jsonSchema.exclusiveMinimum === 'number' && isFinite(jsonSchema.exclusiveMinimum)) {
        numSchema = numSchema.min(jsonSchema.exclusiveMinimum + Number.EPSILON);
        Logger.debug('Applied exclusiveMinimum constraint', { exclusiveMinimum: jsonSchema.exclusiveMinimum });
    }

    if (typeof jsonSchema.exclusiveMaximum === 'number' && isFinite(jsonSchema.exclusiveMaximum)) {
        numSchema = numSchema.max(jsonSchema.exclusiveMaximum - Number.EPSILON);
        Logger.debug('Applied exclusiveMaximum constraint', { exclusiveMaximum: jsonSchema.exclusiveMaximum });
    }

    // ENHANCEMENT: Apply multipleOf constraint
    if (typeof jsonSchema.multipleOf === 'number' &&
        jsonSchema.multipleOf > 0 &&
        isFinite(jsonSchema.multipleOf)) {
        numSchema = numSchema.multipleOf(jsonSchema.multipleOf);
        Logger.debug('Applied multipleOf constraint', { multipleOf: jsonSchema.multipleOf });
    }

    // EDGE CASE: Validate bounds consistency
    if (typeof jsonSchema.minimum === 'number' &&
        typeof jsonSchema.maximum === 'number' &&
        jsonSchema.minimum > jsonSchema.maximum) {
        Logger.warn('Invalid bounds: minimum > maximum, bounds may not work correctly', {
            minimum: jsonSchema.minimum,
            maximum: jsonSchema.maximum
        });
    }

    return numSchema;
}

/**
 * Handles array schema with comprehensive constraint support.
 * 
 * Constraints supported:
 * - items (array element schema)
 * - minItems, maxItems
 * - uniqueItems
 * - Tuple arrays (items as array)
 */
function handleArraySchema(jsonSchema: VSCodeLMJsonSchema): z.ZodTypeAny {
    let arraySchema: z.ZodArray<any>;

    // Handle items schema
    if (jsonSchema.items) {
        // EDGE CASE: Handle tuple arrays (items is array)
        if (Array.isArray(jsonSchema.items)) {
            Logger.debug('Converting tuple array schema', { itemCount: jsonSchema.items.length });
            const tupleSchemas = jsonSchema.items.map(item => vsclmJsonSchemaToZod(item));
            return z.tuple(tupleSchemas as any);
        } else {
            // Standard array with single item schema
            try {
                const itemSchema = vsclmJsonSchemaToZod(jsonSchema.items);
                arraySchema = z.array(itemSchema);
                Logger.debug('Applied array item schema');
            } catch (error) {
                Logger.warn('Invalid items schema, falling back to unknown array', { error });
                arraySchema = z.array(z.unknown());
            }
        }
    } else {
        // No items schema specified
        arraySchema = z.array(z.unknown());
        Logger.debug('No items schema, using unknown array');
    }

    // Apply size constraints
    if (typeof jsonSchema.minItems === 'number' && jsonSchema.minItems >= 0) {
        arraySchema = arraySchema.min(jsonSchema.minItems);
        Logger.debug('Applied minItems constraint', { minItems: jsonSchema.minItems });
    }

    if (typeof jsonSchema.maxItems === 'number' && jsonSchema.maxItems >= 0) {
        arraySchema = arraySchema.max(jsonSchema.maxItems);
        Logger.debug('Applied maxItems constraint', { maxItems: jsonSchema.maxItems });
    }

    // ENHANCEMENT: Handle uniqueItems constraint
    if (jsonSchema.uniqueItems === true) {
        // Note: Zod doesn't have built-in unique validation, but we can add a custom refinement
        const uniqueArraySchema = arraySchema.refine(
            (arr) => arr.length === new Set(arr).size,
            { message: "Array items must be unique" }
        );
        Logger.debug('Applied uniqueItems constraint');
        return uniqueArraySchema;
    }

    return arraySchema;
}

/**
 * Handles object schema with comprehensive property support.
 * 
 * Features supported:
 * - properties (property schemas)
 * - required (required property list)
 * - additionalProperties (allow/disallow extra properties)
 * - minProperties, maxProperties
 */
function handleObjectSchema(jsonSchema: VSCodeLMJsonSchema): z.ZodTypeAny {
    const shape: Record<string, z.ZodTypeAny> = {};
    const required = jsonSchema.required || [];

    // Process defined properties
    if (jsonSchema.properties && typeof jsonSchema.properties === 'object') {
        for (const [key, propSchema] of Object.entries(jsonSchema.properties)) {
            try {
                let propZod = vsclmJsonSchemaToZod(propSchema);

                // Make property optional if not in required array
                if (!required.includes(key)) {
                    propZod = propZod.optional();
                }

                shape[key] = propZod;
                Logger.debug('Added property schema', { property: key, required: required.includes(key) });
            } catch (error) {
                Logger.warn('Invalid property schema, skipping', { property: key, error });
            }
        }
    }

    let objectSchema: z.ZodTypeAny = z.object(shape);

    // Handle additionalProperties
    if (jsonSchema.additionalProperties === false) {
        // Strict mode - no additional properties allowed
        objectSchema = (objectSchema as z.ZodObject<any>).strict();
        Logger.debug('Applied strict mode (no additional properties)');
    } else if (jsonSchema.additionalProperties === true || jsonSchema.additionalProperties === undefined) {
        // Allow additional properties (requires passthrough)
        objectSchema = (objectSchema as z.ZodObject<any>).passthrough();
        Logger.debug('Allowing additional properties');
    }
    // Note: additionalProperties as schema is not commonly supported by Zod

    // ENHANCEMENT: Apply size constraints
    let finalSchema: z.ZodTypeAny = objectSchema;

    if (typeof jsonSchema.minProperties === 'number' && jsonSchema.minProperties >= 0) {
        finalSchema = (finalSchema as any).refine(
            (obj: any) => Object.keys(obj).length >= jsonSchema.minProperties!,
            { message: `Object must have at least ${jsonSchema.minProperties} properties` }
        );
        Logger.debug('Applied minProperties constraint', { minProperties: jsonSchema.minProperties });
    }

    if (typeof jsonSchema.maxProperties === 'number' && jsonSchema.maxProperties >= 0) {
        finalSchema = (finalSchema as any).refine(
            (obj: any) => Object.keys(obj).length <= jsonSchema.maxProperties!,
            { message: `Object must have at most ${jsonSchema.maxProperties} properties` }
        );
        Logger.debug('Applied maxProperties constraint', { maxProperties: jsonSchema.maxProperties });
    }

    return finalSchema;
} 
