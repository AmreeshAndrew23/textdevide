import { z } from "zod";

// Port of app/models/schemas.py — only the Phase 0 (auth + basic project CRUD) subset for now;
// more get added as later phases port their routes.

export const UserRegisterSchema = z.object({
  email: z.string().email(),
  password: z.string(),
  full_name: z.string().nullish(),
});

export const UserLoginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

export const GoogleTokenRequestSchema = z.object({ credential: z.string() });

export const GithubCodeRequestSchema = z.object({
  code: z.string(),
  redirect_uri: z.string().nullish(),
});

export const UserUpdateSchema = z.object({
  full_name: z.string().nullish(),
  github_token: z.string().nullish(),
  date_format: z.string().nullish(),
  language: z.string().nullish(),
});

export const ProjectCreateSchema = z.object({
  name: z.string(),
  description: z.string().nullish(),
  features: z.string().nullish(),
  language: z.string().default("Python"),
  frontend_language: z.string().default("React"),
});

export const ExtractRequestSchema = z.object({
  description: z.string(),
  features: z.string(),
});

export const RefineRequestSchema = z.object({
  entities: z.string(),
  instruction: z.string(),
});

export const SchemaAssistantRequestSchema = z.object({
  instruction: z.string(),
});

export const WorkbenchInterpretRequestSchema = z.object({
  requirement: z.string(),
  current_entities: z.any().nullish(),
  current_screens: z.array(z.any()).nullish(),
  current_validation_rules: z.string().nullish(),
});

export const ScreenCreateSchema = z.object({
  name: z.string(),
  description: z.string().default(""),
  primary_entity: z.string().nullish(),
  primary_entities: z.array(z.string()).nullish(),
  joined_entities: z.array(z.string()).nullish(),
  reference_image: z.string().nullish(),
});

export const ScreenUpdateSchema = z.object({
  name: z.string().nullish(),
  description: z.string().nullish(),
  primary_entity: z.string().nullish(),
  primary_entities: z.array(z.string()).nullish(),
  joined_entities: z.array(z.string()).nullish(),
  reference_image: z.string().nullish(),
});

export const GenerateUIXmlRequestSchema = z.object({
  description: z.string(),
});

export const PreviewRowsRequestSchema = z.object({
  rows: z.array(z.record(z.string(), z.any())),
});

export const RunEventRequestSchema = z.object({
  elementId: z.string(),
  eventType: z.string(),
  fieldValues: z.record(z.string(), z.any()).default({}),
});

export const GenerateValidationRequestSchema = z.object({
  rules: z.string(),
});

export const RefineUIRequestSchema = z.object({
  instruction: z.string(),
});

export const GenerateFromTemplateRequestSchema = z.object({
  template: z.string(),
});

export const BatchGenerateScreensRequestSchema = z.object({
  screens: z.array(z.object({ name: z.string(), description: z.string() })).min(1),
});

export const ProjectUpdateSchema = z.object({
  name: z.string().nullish(),
  description: z.string().nullish(),
  features: z.string().nullish(),
  entities: z.string().nullish(),
  status: z.string().nullish(),
  language: z.string().nullish(),
  validation_rules: z.string().nullish(),
  validation_code: z.string().nullish(),
  ui_description: z.string().nullish(),
  ui_code: z.string().nullish(),
  ui_xml: z.string().nullish(),
  ui_html: z.string().nullish(),
  ui_api: z.string().nullish(),
  frontend_language: z.string().nullish(),
  er_diagram: z.string().nullish(),
  ui_screens: z.string().nullish(),
});
