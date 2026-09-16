export type ValidationError = Readonly<{
  instancePath: string;
  schemaPath: string;
  keyword: string;
  params: Record<string, unknown>;
  message?: string;
}>;
declare function validate(value: unknown): boolean;
declare namespace validate { let errors: ValidationError[] | null | undefined; }
export { validate };
export default validate;
