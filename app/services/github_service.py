import base64
import json
import re
import httpx

from app.services.ai_service import PYTHON_DATABASE_MODULE, PYTHON_EMAIL_SERVICE_MODULE, generate_sqlalchemy_models

GITHUB_API = "https://api.github.com"

EXT = {"Python": "py", "Java": "java", "JavaScript": "js", "TypeScript": "ts",
       "C#": "cs", "Go": "go", "Ruby": "rb", "PHP": "php"}

# Forced pushed-filename extension per frontend_language, for the two AI-generated files
# (api_service / page_component) — mirrors EXT/_backend_file_path's role for the backend.
# The AI is unreliable about substituting a real extension for the prompt's literal
# "page_component.ext" placeholder, so the pushed filename is never taken from the AI.
_FRONTEND_EXT = {
    "React":    {"api_service": "js", "page_component": "jsx"},
    "Next.js":  {"api_service": "js", "page_component": "jsx"},
    "Vue":      {"api_service": "js", "page_component": "vue"},
    "Svelte":   {"api_service": "js", "page_component": "svelte"},
    "Angular":  {"api_service": "service.ts", "page_component": "component.ts"},
    "Flutter":  {"api_service": "dart", "page_component": "dart"},
    "HTML/CSS": {"api_service": "js", "page_component": "html"},
}


def _frontend_file_path(frontend_lang: str, category: str, slug: str) -> str:
    """Where an api_service/page_component file lands in the frontend repo. category
    is 'api_service' or 'page_component'. Mirrors _backend_file_path's reasoning:
    the pushed filename is forced, never taken from the AI's own (unreliable) choice."""
    exts = _FRONTEND_EXT.get(frontend_lang) or _FRONTEND_EXT["React"]
    return f"{slug}/{category}.{exts[category]}"


_FRONTEND_RUN_INSTRUCTIONS = {
    "React": (
        "```\nnpm install\nnpm run dev      # http://localhost:5173 — /api is proxied to "
        "http://localhost:8000, so start the backend first\nnpm run build    # production build -> dist/\n```"
    ),
    "Next.js": (
        "```\nnpm install\nnpm run dev      # http://localhost:3000 — /api is rewritten to "
        "http://localhost:8000, so start the backend first\nnpm run build && npm start\n```"
    ),
    "Vue": (
        "```\nnpm install\nnpm run dev      # http://localhost:5173 — /api is proxied to "
        "http://localhost:8000, so start the backend first\nnpm run build\n```"
    ),
    "Svelte": (
        "```\nnpm install\nnpm run dev      # http://localhost:5173 — /api is proxied to "
        "http://localhost:8000, so start the backend first\nnpm run build\n```"
    ),
    "Angular": (
        "```\nnpm install\nnpm start        # ng serve --proxy-config proxy.conf.json, "
        "http://localhost:4200 — start the backend first\nnpm run build\n```\n\n"
        "**Known limitation:** this scaffold targets Angular 16 (`@angular/cli` ^16.2.4) — "
        "if `ng` reports your Node version as unsupported, use Node 18 LTS, or bump the "
        "Angular dependency versions in `package.json` to a release that supports your Node version."
    ),
    "Flutter": (
        "```\nflutter pub get\nflutter run -d chrome\n```\n\n"
        "**Known limitation:** unlike the JS frameworks above, there is no dev-server proxy "
        "for `/api` calls — `{slug}/api_service.dart` needs an absolute backend URL "
        "(e.g. `http://localhost:8000/api`) to reach the backend from a Flutter web/mobile "
        "build. The backend already allows all origins (`allow_origins=[\"*\"]`), so this is "
        "just a matter of setting the URL — it won't work with the relative `/api/...` path "
        "as generated."
    ),
    "HTML/CSS": (
        "Open `index.html` directly in a browser, or serve statically (e.g. `npx serve .`) "
        "and browse to any screen listed there. Each screen under `preview/` is already a "
        "complete, standalone page — no build step needed."
    ),
}


def _headers(token: str) -> dict:
    return {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }


def _slugify(name: str) -> str:
    slug = re.sub(r"[^a-zA-Z0-9\-_.]", "-", name).strip("-")
    return slug[:100] or "project"


def _safe_ident(name: str) -> str:
    """Sanitizes a screen name into an identifier safe to use as a Python/Java/
    C#/Go/JS module, package, or variable name (no dashes, doesn't start with a digit)."""
    ident = re.sub(r"[^a-zA-Z0-9_]", "_", name or "screen").strip("_") or "screen"
    if ident[0].isdigit():
        ident = f"s_{ident}"
    return ident


def _strip_md_fence(text: str) -> str:
    """Removes a leading/trailing markdown code fence if the model added one
    despite being told not to (e.g. ```json ... ``` or ```python ... ```)."""
    trimmed = text.strip()
    m = re.match(r"^```[a-zA-Z0-9]*\n?([\s\S]*?)\n?```$", trimmed)
    return m.group(1).strip() if m else trimmed


def _parse_bundle(code: str, fallback_name: str) -> list[dict]:
    """Splits a === FILENAME: x === delimited bundle into real, individually
    named files — mirrors the frontend's parseFiles() so what gets pushed to
    GitHub is actual runnable source, not one blob with embedded markers."""
    if not code:
        return []
    parts = re.split(r"^=== FILENAME:\s*(.+?)\s*===$", code, flags=re.MULTILINE)
    if len(parts) <= 1:
        return [{"name": fallback_name, "code": _strip_md_fence(code)}]
    files = []
    for i in range(1, len(parts), 2):
        name = parts[i].strip() if i < len(parts) else None
        body = parts[i + 1].strip() if i + 1 < len(parts) else None
        if name and body:
            files.append({"name": name, "code": _strip_md_fence(body)})
    return files or [{"name": fallback_name, "code": _strip_md_fence(code)}]


_BACKEND_FILE_RE = re.compile(r"^(routes|models)\b", re.IGNORECASE)
_FRONTEND_FILE_RE = re.compile(r"^(api_service|page_component)\b", re.IGNORECASE)
_CONTRACTS_FILE_RE = re.compile(r"contract", re.IGNORECASE)

# Position in the generate-api bundle when a file can't be classified by name alone
# (e.g. Java/C# name their routes file after the controller class, not "routes.ext").
# The prompt always emits routes, models, contracts, api_service, page_component in
# this order, so index is a reliable fallback signal.
_POSITION_BACKEND_ROUTES = 0
_POSITION_BACKEND_MODELS = 1
_POSITION_FRONTEND_API_SERVICE = 3
_POSITION_FRONTEND_PAGE_COMPONENT = 4


def _backend_file_path(language: str, category: str, slug: str, ai_filename: str) -> str:
    """Where a routes/models file lands in the backend repo, following each
    language's idiomatic project layout. category is 'routes' or 'models'."""
    if language == "Java":
        sub = "controller" if category == "routes" else "model"
        # Java requires the filename to match the public class name exactly to
        # compile, so we trust the AI's own filename here (enforced via prompt).
        return f"src/main/java/com/textdevide/app/{sub}/{ai_filename}"
    if language == "C#":
        sub = "Controllers" if category == "routes" else "Models"
        return f"{sub}/{ai_filename}"
    if language in ("JavaScript", "TypeScript"):
        ext = EXT.get(language, "js")
        return f"routes/{slug}.routes.{ext}" if category == "routes" else f"models/{slug}.model.{ext}"
    if language == "Go":
        # Own directory per screen = own Go package, so multiple screens can each
        # expose a same-named RegisterRoutes() without colliding at compile time.
        return f"handlers/{slug}/routes.go" if category == "routes" else f"handlers/{slug}/models.go"
    if language == "Ruby":
        return f"routes/{slug}.rb" if category == "routes" else f"models/{slug}.rb"
    if language == "PHP":
        return f"routes/{slug}.php" if category == "routes" else f"models/{slug}.php"
    # Python default: grouped per screen, matches FastAPI router-per-feature convention.
    # Filename is forced (not taken from the AI) because the model sometimes echoes the
    # literal "routes.ext" placeholder from the prompt instead of substituting ".py" —
    # main.py's import wiring below depends on this file being named exactly routes.py.
    return f"{slug}/routes.py" if category == "routes" else f"{slug}/models.py"


# Where the shared auth module (project.auth_code, see ai_service.generate_auth_module) lands —
# MUST match the exact path AUTH_CONVENTIONS tells the AI to import in ai_service.py, for every
# other screen's generated routes to actually resolve the import. Python's goes at the repo root
# (a sibling of main.py, NOT inside common-library/) since that folder is hyphenated and was
# never a real importable package to begin with.
_AUTH_MODULE_PATH = {
    "Python": "auth.py",
    "Java": "src/main/java/com/textdevide/app/security/AuthUtil.java",
    "JavaScript": "middleware/auth.js",
    "TypeScript": "middleware/auth.ts",
    "C#": "Security/AuthService.cs",
    "Go": "middleware/auth.go",
    "Ruby": "lib/auth.rb",
    "PHP": "lib/auth.php",
}


def _auth_module_path(language: str) -> str:
    return _AUTH_MODULE_PATH.get(language, f"auth.{EXT.get(language, 'txt')}")


# Where the real live-database wiring lands — Python's is two files (engine/session, and the ORM
# model classes) since ai_service generates them as two separate deterministic pieces; every other
# language gets a single conventional path (see DB_CONVENTIONS in ai_service.py, which every
# screen's own generated routes are told to import from). Present whenever project.entities has at
# least one table — this is now the baseline for every project, not an opt-in like auth.
_DB_MODULE_PATH = {
    "Python": ("database.py", "db_models.py"),
    "Java": ("src/main/java/com/textdevide/app/config/DatabaseConfig.java", None),
    "JavaScript": ("db/connection.js", None),
    "TypeScript": ("db/connection.ts", None),
    "C#": ("Data/AppDbContext.cs", None),
    "Go": ("db/db.go", None),
    "Ruby": ("config/database.rb", None),
    "PHP": ("lib/db.php", None),
}

# Where the shared email-sending module (project.email_code) lands — same shape as
# _AUTH_MODULE_PATH, MUST match what EMAIL_CONVENTIONS tells the AI to import.
_EMAIL_MODULE_PATH = {
    "Python": "email_service.py",
    "Java": "src/main/java/com/textdevide/app/service/EmailService.java",
    "JavaScript": "lib/emailService.js",
    "TypeScript": "lib/emailService.ts",
    "C#": "Services/EmailService.cs",
    "Go": "email/email.go",
    "Ruby": "lib/email.rb",
    "PHP": "lib/email.php",
}


def _email_module_path(language: str) -> str:
    return _EMAIL_MODULE_PATH.get(language, f"email_service.{EXT.get(language, 'txt')}")


def _python_scaffold(project, screen_slugs: list[str]) -> dict:
    imports = "\n".join(f"from {s}.routes import router as {s}_router" for s in screen_slugs)
    includes = "\n".join(f'app.include_router({s}_router, prefix="/api")' for s in screen_slugs)
    # A real database is the baseline once there's a schema at all — not opt-in like auth/email.
    # Importing Base/engine and creating tables here (rather than only relying on some screen's own
    # db_models import to trigger it) guarantees the tables exist even before any screen is hit.
    has_db = bool(project.entities)
    db_import = "\nfrom database import Base, engine" if has_db else ""
    db_create = "\nBase.metadata.create_all(bind=engine)\n" if has_db else ""
    main_py = f'''"""Entrypoint — wires every generated screen's router into one FastAPI app.
Run with: pip install -r requirements.txt && uvicorn main:app --reload
"""
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware{db_import}
{(chr(10) + imports) if imports else ""}

app = FastAPI(title="{project.name}")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # tighten this to your real frontend origin before production
    allow_methods=["*"],
    allow_headers=["*"],
)
{db_create}

@app.get("/health")
async def health():
    return {{"status": "ok"}}

{includes}
'''
    requirements = "fastapi\nuvicorn[standard]\npydantic[email]\npandas\nopenpyxl\n"
    if has_db:
        requirements += "sqlalchemy\n"
    if project.auth_code:
        requirements += "passlib[bcrypt]\nbcrypt==4.0.1\npython-jose[cryptography]\n"
    return {"main.py": main_py, "requirements.txt": requirements}


def _java_scaffold(project) -> dict:
    artifact = _slugify(project.name).lower() or "app"
    auth_deps = '''
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-security</artifactId>
    </dependency>
    <dependency>
      <groupId>io.jsonwebtoken</groupId>
      <artifactId>jjwt-api</artifactId>
      <version>0.11.5</version>
    </dependency>
    <dependency>
      <groupId>io.jsonwebtoken</groupId>
      <artifactId>jjwt-impl</artifactId>
      <version>0.11.5</version>
      <scope>runtime</scope>
    </dependency>
    <dependency>
      <groupId>io.jsonwebtoken</groupId>
      <artifactId>jjwt-jackson</artifactId>
      <version>0.11.5</version>
      <scope>runtime</scope>
    </dependency>''' if project.auth_code else ""
    db_deps = '''
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-data-jpa</artifactId>
    </dependency>
    <dependency>
      <groupId>org.xerial</groupId>
      <artifactId>sqlite-jdbc</artifactId>
      <version>3.45.1.0</version>
    </dependency>''' if project.entities else ""
    email_deps = '''
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-mail</artifactId>
    </dependency>''' if project.email_code else ""
    pom = f'''<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 http://maven.apache.org/xsd/maven-4.0.0.xsd">
  <modelVersion>4.0.0</modelVersion>
  <parent>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-parent</artifactId>
    <version>3.2.5</version>
    <relativePath/>
  </parent>
  <groupId>com.textdevide</groupId>
  <artifactId>{artifact}</artifactId>
  <version>0.0.1-SNAPSHOT</version>
  <properties>
    <java.version>17</java.version>
  </properties>
  <dependencies>
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-web</artifactId>
    </dependency>
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-validation</artifactId>
    </dependency>{auth_deps}{db_deps}{email_deps}
  </dependencies>
  <build>
    <plugins>
      <plugin>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-maven-plugin</artifactId>
      </plugin>
    </plugins>
  </build>
</project>
'''
    application_java = '''package com.textdevide.app;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.context.annotation.Bean;
import org.springframework.web.servlet.config.annotation.CorsRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

// Spring Boot component-scans this package and everything under it, so every
// generated @RestController in controller/ is picked up automatically — no
// manual router registration needed, unlike FastAPI/Express.
@SpringBootApplication
public class Application {

    public static void main(String[] args) {
        SpringApplication.run(Application.class, args);
    }

    @Bean
    public WebMvcConfigurer corsConfigurer() {
        return new WebMvcConfigurer() {
            @Override
            public void addCorsMappings(CorsRegistry registry) {
                // tighten allowedOrigins to your real frontend origin before production
                registry.addMapping("/**").allowedOrigins("*").allowedMethods("*");
            }
        };
    }
}
'''
    return {
        "pom.xml": pom,
        "src/main/java/com/textdevide/app/Application.java": application_java,
        "src/main/resources/application.properties": "server.port=8000\n",
    }


def _node_scaffold(project, language: str, screen_slugs: list[str]) -> dict:
    is_ts = language == "TypeScript"
    ext = "ts" if is_ts else "js"
    has_auth = bool(project.auth_code)
    if is_ts:
        imports = "\n".join(f'import {s}Router from "./routes/{s}.routes";' for s in screen_slugs)
        mounts = "\n".join(f"app.use('/api', {s}Router);" for s in screen_slugs)
        entry = f'''import express from "express";
import cors from "cors";
{imports}

const app = express();
app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => res.json({{ status: "ok" }}));

{mounts}

const PORT = process.env.PORT || 8000;
app.listen(PORT, () => console.log(`Server running on port ${{PORT}}`));
'''
        entry_path = f"src/server.{ext}"
        tsconfig = '''{
  "compilerOptions": {
    "target": "ES2020",
    "module": "commonjs",
    "moduleResolution": "node",
    "esModuleInterop": true,
    "outDir": "dist",
    "strict": false
  },
  "include": ["src/**/*", "routes/**/*", "models/**/*"]
}
'''
        ts_auth_deps = ',\n    "bcryptjs": "^2.4.3",\n    "jsonwebtoken": "^9.0.2"' if has_auth else ""
        ts_auth_dev_deps = ',\n    "@types/bcryptjs": "^2.4.6",\n    "@types/jsonwebtoken": "^9.0.6"' if has_auth else ""
        ts_db_deps = ',\n    "better-sqlite3": "^11.1.2"' if project.entities else ""
        ts_db_dev_deps = ',\n    "@types/better-sqlite3": "^7.6.10"' if project.entities else ""
        ts_email_deps = ',\n    "nodemailer": "^6.9.13"' if project.email_code else ""
        ts_email_dev_deps = ',\n    "@types/nodemailer": "^6.4.15"' if project.email_code else ""
        package_json = f'''{{
  "name": "{_slugify(project.name).lower()}-backend",
  "version": "1.0.0",
  "private": true,
  "scripts": {{
    "dev": "ts-node-dev --respawn src/server.ts",
    "build": "tsc",
    "start": "node dist/server.js"
  }},
  "dependencies": {{
    "express": "^4.19.2",
    "cors": "^2.8.5"{ts_auth_deps}{ts_db_deps}{ts_email_deps}
  }},
  "devDependencies": {{
    "typescript": "^5.4.5",
    "ts-node-dev": "^2.0.0",
    "@types/express": "^4.17.21",
    "@types/cors": "^2.8.17",
    "@types/node": "^20.12.7"{ts_auth_dev_deps}{ts_db_dev_deps}{ts_email_dev_deps}
  }}
}}
'''
        return {entry_path: entry, "package.json": package_json, "tsconfig.json": tsconfig}

    requires = "\n".join(f'const {s}Router = require("./routes/{s}.routes");' for s in screen_slugs)
    mounts = "\n".join(f"app.use('/api', {s}Router);" for s in screen_slugs)
    entry = f'''const express = require("express");
const cors = require("cors");
{requires}

const app = express();
app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => res.json({{ status: "ok" }}));

{mounts}

const PORT = process.env.PORT || 8000;
app.listen(PORT, () => console.log(`Server running on port ${{PORT}}`));
'''
    js_auth_deps = ',\n    "bcryptjs": "^2.4.3",\n    "jsonwebtoken": "^9.0.2"' if has_auth else ""
    js_db_deps = ',\n    "better-sqlite3": "^11.1.2"' if project.entities else ""
    js_email_deps = ',\n    "nodemailer": "^6.9.13"' if project.email_code else ""
    package_json = f'''{{
  "name": "{_slugify(project.name).lower()}-backend",
  "version": "1.0.0",
  "private": true,
  "main": "index.js",
  "scripts": {{
    "dev": "node index.js",
    "start": "node index.js"
  }},
  "dependencies": {{
    "express": "^4.19.2",
    "cors": "^2.8.5"{js_auth_deps}{js_db_deps}{js_email_deps}
  }}
}}
'''
    return {"index.js": entry, "package.json": package_json}


def _csharp_scaffold(project) -> dict:
    project_name = re.sub(r"[^a-zA-Z0-9]", "", project.name or "App") or "App"
    program_cs = '''var builder = WebApplication.CreateBuilder(args);

builder.Services.AddControllers();
builder.Services.AddCors(options =>
{
    // tighten this to your real frontend origin before production
    options.AddDefaultPolicy(policy => policy.AllowAnyOrigin().AllowAnyMethod().AllowAnyHeader());
});

var app = builder.Build();

app.UseCors();
app.MapControllers();
app.MapGet("/health", () => Results.Ok(new { status = "ok" }));

app.Run();
'''
    auth_refs = '''
  <ItemGroup>
    <PackageReference Include="BCrypt.Net-Next" Version="4.0.3" />
    <PackageReference Include="System.IdentityModel.Tokens.Jwt" Version="7.5.1" />
  </ItemGroup>''' if project.auth_code else ""
    db_refs = '''
  <ItemGroup>
    <PackageReference Include="Microsoft.EntityFrameworkCore.Sqlite" Version="8.0.4" />
  </ItemGroup>''' if project.entities else ""
    email_refs = '''
  <ItemGroup>
    <PackageReference Include="MailKit" Version="4.6.0" />
  </ItemGroup>''' if project.email_code else ""
    csproj = f'''<Project Sdk="Microsoft.NET.Sdk.Web">
  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>enable</Nullable>
  </PropertyGroup>{auth_refs}{db_refs}{email_refs}
</Project>
'''
    return {"Program.cs": program_cs, f"{project_name}.csproj": csproj}


def _go_scaffold(project, screen_slugs: list[str]) -> dict:
    module = _slugify(project.name).lower().replace("-", "") or "app"
    imports = "\n".join(f'\t{s.lower()} "{module}/handlers/{s}"' for s in screen_slugs)
    calls = "\n".join(f"\t{s.lower()}.RegisterRoutes(mux)" for s in screen_slugs)
    main_go = f'''package main

import (
\t"log"
\t"net/http"
{(chr(10) + imports) if imports else ""}
)

func main() {{
\tmux := http.NewServeMux()
\tmux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {{
\t\tw.Write([]byte(`{{"status":"ok"}}`))
\t}})

{calls}

\tlog.Println("Server running on :8000")
\tlog.Fatal(http.ListenAndServe(":8000", mux))
}}
'''
    go_mod = f"module {module}\n\ngo 1.21\n"
    go_requires = []
    if project.auth_code:
        go_requires += ["golang.org/x/crypto v0.21.0", "github.com/golang-jwt/jwt/v5 v5.2.1"]
    if project.entities:
        go_requires.append("github.com/mattn/go-sqlite3 v1.14.22")
    if go_requires:
        go_mod += "\nrequire (\n" + "\n".join(f"\t{r}" for r in go_requires) + "\n)\n"
    return {"main.go": main_go, "go.mod": go_mod}


def _ruby_scaffold(project) -> dict:
    gemfile = 'source "https://rubygems.org"\n\ngem "sinatra"\ngem "sinatra-contrib"\ngem "rack-cors"\n'
    if project.auth_code:
        gemfile += 'gem "bcrypt"\ngem "jwt"\n'
    if project.entities:
        gemfile += 'gem "sqlite3"\ngem "activerecord"\n'
    app_rb = '''# Entrypoint. Each screen's routes.rb under routes/ needs to be require'd and
# mounted here manually — see the comment in each file for its expected mount path.
require "sinatra"
require "sinatra/base"
require "rack/cors"

use Rack::Cors do
  allow do
    origins "*"
    resource "*", headers: :any, methods: [:get, :post, :put, :delete, :options]
  end
end

get "/health" do
  content_type :json
  '{"status":"ok"}'
end
'''
    return {"Gemfile": gemfile, "app.rb": app_rb}


def _php_scaffold(project) -> dict:
    php_auth_deps = ',\n    "firebase/php-jwt": "^6.10"' if project.auth_code else ""
    php_email_deps = ',\n    "phpmailer/phpmailer": "^6.9"' if project.email_code else ""
    composer = f'''{{
  "name": "textdevide/backend",
  "require": {{
    "php": ">=8.1"{php_auth_deps}{php_email_deps}
  }}
}}
'''
    index_php = '''<?php
// Entrypoint. Each screen's routes.php under routes/ needs to be require'd and
// registered here manually — see the comment in each file for its expected route prefix.

header("Access-Control-Allow-Origin: *");
header("Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS");
header("Access-Control-Allow-Headers: Content-Type");
header("Content-Type: application/json");

if ($_SERVER["REQUEST_URI"] === "/health") {
    echo json_encode(["status" => "ok"]);
    exit;
}
'''
    return {"composer.json": composer, "index.php": index_php}


def _backend_scaffold(project, screen_slugs: list[str]) -> dict:
    """Deterministic (non-AI) entrypoint + dependency manifest + CORS config,
    generated once per push so the pushed repo is actually runnable, not just
    a pile of per-screen source files."""
    language = project.language
    if language == "Java":
        return _java_scaffold(project)
    if language in ("JavaScript", "TypeScript"):
        return _node_scaffold(project, language, screen_slugs)
    if language == "C#":
        return _csharp_scaffold(project)
    if language == "Go":
        return _go_scaffold(project, screen_slugs)
    if language == "Ruby":
        return _ruby_scaffold(project)
    if language == "PHP":
        return _php_scaffold(project)
    return _python_scaffold(project, screen_slugs)


def _frontend_import_alias(slug: str) -> str:
    """Deterministic, import-safe identifier for a screen's module — doesn't need to
    match the AI's own unpredictable default-exported name (see _FRONTEND_EXT's docstring)."""
    return f"Screen_{_safe_ident(slug)}"


def _react_scaffold(project, screens: list[dict]) -> dict:
    """Deterministic (non-AI) package manifest + Vite config + entry point + a router
    that wires every screen's page_component into real navigation — the frontend
    equivalent of _backend_scaffold, generated once per push."""
    aliases = [(_frontend_import_alias(s["slug"]), s["slug"], s["name"]) for s in screens]
    imports = "\n".join(f"import {a} from '../{slug}/page_component.jsx';" for a, slug, _ in aliases)
    entries = ",\n  ".join(
        f'{{ slug: {json.dumps(slug)}, name: {json.dumps(name)}, Component: {a} }}'
        for a, slug, name in aliases
    )
    default_path = f"/{aliases[0][1]}" if aliases else "/"

    if aliases:
        app_jsx = (
            "import { Routes, Route, Link, Navigate } from 'react-router-dom';\n"
            + imports + "\n\n"
            "const SCREENS = [\n"
            "  " + entries + "\n"
            "];\n\n"
            "export default function App() {\n"
            "  return (\n"
            "    <div>\n"
            "      <nav>\n"
            "        <ul>\n"
            "          {SCREENS.map((s) => (\n"
            "            <li key={s.slug}><Link to={`/${s.slug}`}>{s.name}</Link></li>\n"
            "          ))}\n"
            "        </ul>\n"
            "      </nav>\n"
            "      <Routes>\n"
            '        <Route path="/" element={<Navigate to="' + default_path + '" replace />} />\n'
            "        {SCREENS.map(({ slug, Component }) => (\n"
            "          <Route key={slug} path={`/${slug}`} element={<Component />} />\n"
            "        ))}\n"
            "      </Routes>\n"
            "    </div>\n"
            "  );\n"
            "}\n"
        )
    else:
        app_jsx = (
            "export default function App() {\n"
            "  return <div>No screens generated yet — build one in Text Dev IDE, then push again.</div>;\n"
            "}\n"
        )

    main_jsx = (
        "import { StrictMode } from 'react';\n"
        "import { createRoot } from 'react-dom/client';\n"
        "import { BrowserRouter } from 'react-router-dom';\n"
        "import App from './App.jsx';\n\n"
        "createRoot(document.getElementById('root')).render(\n"
        "  <StrictMode>\n"
        "    <BrowserRouter>\n"
        "      <App />\n"
        "    </BrowserRouter>\n"
        "  </StrictMode>,\n"
        ");\n"
    )

    index_html = (
        "<!doctype html>\n"
        '<html lang="en">\n'
        "  <head>\n"
        '    <meta charset="UTF-8" />\n'
        "    <title>" + project.name + "</title>\n"
        "  </head>\n"
        "  <body>\n"
        '    <div id="root"></div>\n'
        '    <script type="module" src="/src/main.jsx"></script>\n'
        "  </body>\n"
        "</html>\n"
    )

    vite_config = (
        "import { defineConfig } from 'vite';\n"
        "import react from '@vitejs/plugin-react';\n\n"
        "export default defineConfig({\n"
        "  plugins: [react()],\n"
        "  server: {\n"
        "    proxy: {\n"
        "      '/api': { target: 'http://localhost:8000', changeOrigin: true },\n"
        "    },\n"
        "  },\n"
        "});\n"
    )

    package_json = json.dumps({
        "name": f"{_slugify(project.name).lower()}-frontend",
        "private": True,
        "version": "1.0.0",
        "type": "module",
        "scripts": {"dev": "vite", "build": "vite build", "preview": "vite preview"},
        "dependencies": {
            "react": "^19.2.6", "react-dom": "^19.2.6",
            "react-router-dom": "^7.18.0", "axios": "^1.18.1",
        },
        "devDependencies": {"@vitejs/plugin-react": "^6.0.1", "vite": "^8.0.12"},
    }, indent=2) + "\n"

    return {
        "package.json": package_json,
        "vite.config.js": vite_config,
        "index.html": index_html,
        "src/main.jsx": main_jsx,
        "src/App.jsx": app_jsx,
        ".gitignore": "node_modules/\ndist/\n",
    }


def _nextjs_scaffold(project, screens: list[dict]) -> dict:
    """Next.js needs page files under pages/ to get automatic routing — rather than
    special-case where page_component.jsx itself lives (every other framework keeps it
    in {slug}/, consistently), each screen gets a thin pages/{slug}.jsx wrapper that
    just re-exports the real component from its normal location."""
    files = {}
    nav_items = "\n".join(
        '          <li key="' + s["slug"] + '"><Link href="/' + s["slug"] + '">' + s["name"] + "</Link></li>"
        for s in screens
    )
    index_js = (
        "import Link from 'next/link';\n\n"
        "export default function Home() {\n"
        "  return (\n"
        "    <div>\n"
        "      <h1>" + project.name + "</h1>\n"
        "      <ul>\n"
        + nav_items + "\n"
        "      </ul>\n"
        "    </div>\n"
        "  );\n"
        "}\n"
    )
    app_js = (
        "export default function App({ Component, pageProps }) {\n"
        "  return <Component {...pageProps} />;\n"
        "}\n"
    )
    next_config = (
        "/** @type {import('next').NextConfig} */\n"
        "module.exports = {\n"
        "  async rewrites() {\n"
        "    return [{ source: '/api/:path*', destination: 'http://localhost:8000/api/:path*' }];\n"
        "  },\n"
        "};\n"
    )
    package_json = json.dumps({
        "name": f"{_slugify(project.name).lower()}-frontend",
        "private": True,
        "version": "1.0.0",
        "scripts": {"dev": "next dev", "build": "next build", "start": "next start"},
        "dependencies": {"next": "^15.0.0", "react": "^19.2.6", "react-dom": "^19.2.6", "axios": "^1.18.1"},
    }, indent=2) + "\n"

    files["package.json"] = package_json
    files["next.config.js"] = next_config
    files["pages/_app.js"] = app_js
    files["pages/index.js"] = index_js
    files[".gitignore"] = "node_modules/\n.next/\n"
    for s in screens:
        files["pages/" + s["slug"] + ".jsx"] = "export { default } from '../" + s["slug"] + "/page_component';\n"
    return files


def _vue_scaffold(project, screens: list[dict]) -> dict:
    aliases = [(_frontend_import_alias(s["slug"]), s["slug"], s["name"]) for s in screens]
    imports = "\n".join("import " + a + " from '../" + slug + "/page_component.vue';" for a, slug, _ in aliases)
    route_entries = ",\n  ".join(
        '{ path: "/' + slug + '", name: ' + json.dumps(name) + ', component: ' + a + ' }'
        for a, slug, name in aliases
    )
    nav_entries = ",\n  ".join(
        '{ slug: "' + slug + '", name: ' + json.dumps(name) + ' }' for _, slug, name in aliases
    )
    default_path = "/" + aliases[0][1] if aliases else "/"

    router_js = (
        "import { createRouter, createWebHistory } from 'vue-router';\n"
        + imports + "\n\n"
        "const routes = [\n"
        "  { path: '/', redirect: '" + default_path + "' },\n"
        "  " + route_entries + "\n"
        "];\n\n"
        "export default createRouter({\n"
        "  history: createWebHistory(),\n"
        "  routes,\n"
        "});\n"
    )
    main_js = (
        "import { createApp } from 'vue';\n"
        "import App from './App.vue';\n"
        "import router from './router.js';\n\n"
        "createApp(App).use(router).mount('#app');\n"
    )
    app_vue = (
        "<template>\n"
        "  <nav>\n"
        "    <ul>\n"
        '      <li v-for="s in screens" :key="s.slug">\n'
        "        <router-link :to=\"'/' + s.slug\">{{ s.name }}</router-link>\n"
        "      </li>\n"
        "    </ul>\n"
        "  </nav>\n"
        "  <router-view />\n"
        "</template>\n\n"
        "<script setup>\n"
        "const screens = [\n"
        "  " + nav_entries + "\n"
        "];\n"
        "</script>\n"
    )
    vite_config = (
        "import { defineConfig } from 'vite';\n"
        "import vue from '@vitejs/plugin-vue';\n\n"
        "export default defineConfig({\n"
        "  plugins: [vue()],\n"
        "  server: {\n"
        "    proxy: {\n"
        "      '/api': { target: 'http://localhost:8000', changeOrigin: true },\n"
        "    },\n"
        "  },\n"
        "});\n"
    )
    index_html = (
        "<!doctype html>\n"
        '<html lang="en">\n'
        "  <head>\n"
        '    <meta charset="UTF-8" />\n'
        "    <title>" + project.name + "</title>\n"
        "  </head>\n"
        "  <body>\n"
        '    <div id="app"></div>\n'
        '    <script type="module" src="/src/main.js"></script>\n'
        "  </body>\n"
        "</html>\n"
    )
    package_json = json.dumps({
        "name": f"{_slugify(project.name).lower()}-frontend",
        "private": True,
        "version": "1.0.0",
        "type": "module",
        "scripts": {"dev": "vite", "build": "vite build", "preview": "vite preview"},
        "dependencies": {"vue": "^3.5.0", "vue-router": "^4.4.0", "axios": "^1.18.1"},
        "devDependencies": {"@vitejs/plugin-vue": "^6.0.0", "vite": "^8.0.12"},
    }, indent=2) + "\n"

    return {
        "package.json": package_json,
        "vite.config.js": vite_config,
        "index.html": index_html,
        "src/main.js": main_js,
        "src/App.vue": app_vue,
        "src/router.js": router_js,
        ".gitignore": "node_modules/\ndist/\n",
    }


def _svelte_scaffold(project, screens: list[dict]) -> dict:
    aliases = [(_frontend_import_alias(s["slug"]), s["slug"], s["name"]) for s in screens]
    imports = "\n".join("  import " + a + " from '../" + slug + "/page_component.svelte';" for a, slug, _ in aliases)
    nav_entries = ",\n    ".join(
        '{ slug: "' + slug + '", name: ' + json.dumps(name) + ' }' for _, slug, name in aliases
    )
    routes = "\n  ".join("<Route path=\"" + slug + "\" component={" + a + "} />" for a, slug, _ in aliases)

    main_js = (
        "import { mount } from 'svelte';\n"
        "import App from './App.svelte';\n\n"
        "const app = mount(App, { target: document.getElementById('app') });\n\n"
        "export default app;\n"
    )
    app_svelte = (
        "<script>\n"
        "  import { Router, Link, Route } from 'svelte-routing';\n"
        + imports + "\n\n"
        "  const screens = [\n"
        "    " + nav_entries + "\n"
        "  ];\n"
        "</script>\n\n"
        "<Router>\n"
        "  <nav>\n"
        "    <ul>\n"
        "      {#each screens as s (s.slug)}\n"
        "        <li><Link to={s.slug}>{s.name}</Link></li>\n"
        "      {/each}\n"
        "    </ul>\n"
        "  </nav>\n"
        "  " + routes + "\n"
        "</Router>\n"
    )
    vite_config = (
        "import { defineConfig } from 'vite';\n"
        "import { svelte } from '@sveltejs/vite-plugin-svelte';\n\n"
        "export default defineConfig({\n"
        "  plugins: [svelte()],\n"
        "  server: {\n"
        "    proxy: {\n"
        "      '/api': { target: 'http://localhost:8000', changeOrigin: true },\n"
        "    },\n"
        "  },\n"
        "});\n"
    )
    index_html = (
        "<!doctype html>\n"
        '<html lang="en">\n'
        "  <head>\n"
        '    <meta charset="UTF-8" />\n'
        "    <title>" + project.name + "</title>\n"
        "  </head>\n"
        "  <body>\n"
        '    <div id="app"></div>\n'
        '    <script type="module" src="/src/main.js"></script>\n'
        "  </body>\n"
        "</html>\n"
    )
    package_json = json.dumps({
        "name": f"{_slugify(project.name).lower()}-frontend",
        "private": True,
        "version": "1.0.0",
        "type": "module",
        "scripts": {"dev": "vite", "build": "vite build", "preview": "vite preview"},
        "dependencies": {"svelte-routing": "^2.13.0", "axios": "^1.18.1"},
        "devDependencies": {"svelte": "^5.0.0", "@sveltejs/vite-plugin-svelte": "^7.0.0", "vite": "^8.0.12"},
    }, indent=2) + "\n"

    return {
        "package.json": package_json,
        "vite.config.js": vite_config,
        "index.html": index_html,
        "src/main.js": main_js,
        "src/App.svelte": app_svelte,
        ".gitignore": "node_modules/\ndist/\n",
    }


def _angular_scaffold(project, screens: list[dict]) -> dict:
    """Standalone components + loadComponent routing (Angular 14+, stable on 16). Each
    screen's page_component.ext class name is forced to ScreenPageComponent via
    FRONTEND_CONVENTIONS (ai_service.py), so this can import it by a real, typed name —
    no runtime name-sniffing needed, unlike React/Vue/Svelte's default-export trick,
    because a dynamic import()'s module namespace has no reliable "the one export"."""
    route_entries = ",\n  ".join(
        '{ path: "' + s["slug"] + '", loadComponent: () => '
        "import('../../" + s["slug"] + "/page_component.component').then(m => m.ScreenPageComponent) }"
        for s in screens
    )
    default_path = screens[0]["slug"] if screens else ""
    nav_entries = ",\n    ".join(
        '{ slug: "' + s["slug"] + '", name: ' + json.dumps(s["name"]) + ' }' for s in screens
    )

    routes_ts = (
        "import { Routes } from '@angular/router';\n\n"
        "export const routes: Routes = [\n"
        "  { path: '', redirectTo: '" + default_path + "', pathMatch: 'full' },\n"
        "  " + route_entries + "\n"
        "];\n"
    )
    main_ts = (
        "import { bootstrapApplication } from '@angular/platform-browser';\n"
        "import { provideRouter } from '@angular/router';\n"
        "import { provideHttpClient } from '@angular/common/http';\n"
        "import { AppComponent } from './app/app.component';\n"
        "import { routes } from './app/app.routes';\n\n"
        "bootstrapApplication(AppComponent, {\n"
        "  providers: [provideRouter(routes), provideHttpClient()],\n"
        "}).catch((err) => console.error(err));\n"
    )
    app_component_ts = (
        "import { Component } from '@angular/core';\n"
        "import { RouterOutlet, RouterLink } from '@angular/router';\n"
        "import { NgFor } from '@angular/common';\n\n"
        "@Component({\n"
        "  selector: 'app-root',\n"
        "  standalone: true,\n"
        "  imports: [RouterOutlet, RouterLink, NgFor],\n"
        "  template: `\n"
        "    <nav>\n"
        "      <ul>\n"
        "        <li *ngFor=\"let s of screens\"><a [routerLink]=\"'/' + s.slug\">{{ s.name }}</a></li>\n"
        "      </ul>\n"
        "    </nav>\n"
        "    <router-outlet></router-outlet>\n"
        "  `,\n"
        "})\n"
        "export class AppComponent {\n"
        "  screens = [\n"
        "    " + nav_entries + "\n"
        "  ];\n"
        "}\n"
    )
    index_html = (
        "<!doctype html>\n"
        '<html lang="en">\n'
        "<head>\n"
        '  <meta charset="UTF-8">\n'
        "  <title>" + project.name + "</title>\n"
        '  <base href="/">\n'
        "</head>\n"
        "<body>\n"
        "  <app-root></app-root>\n"
        "</body>\n"
        "</html>\n"
    )
    proxy_conf = json.dumps({"/api": {"target": "http://localhost:8000", "secure": False}}, indent=2) + "\n"
    angular_json = json.dumps({
        "$schema": "./node_modules/@angular/cli/lib/config/schema.json",
        "version": 1,
        "projects": {
            "app": {
                "projectType": "application",
                "root": "",
                "sourceRoot": "src",
                "architect": {
                    "build": {
                        "builder": "@angular-devkit/build-angular:application",
                        "options": {
                            "outputPath": "dist",
                            "index": "src/index.html",
                            "browser": "src/main.ts",
                            "tsConfig": "tsconfig.json",
                        },
                    },
                    "serve": {"builder": "@angular-devkit/build-angular:dev-server"},
                },
            },
        },
    }, indent=2) + "\n"
    tsconfig = json.dumps({
        "compilerOptions": {
            "target": "ES2022", "module": "ES2022", "moduleResolution": "bundler",
            "strict": True, "experimentalDecorators": True, "skipLibCheck": True,
        },
    }, indent=2) + "\n"
    package_json = json.dumps({
        "name": f"{_slugify(project.name).lower()}-frontend",
        "private": True,
        "version": "1.0.0",
        "scripts": {"start": "ng serve --proxy-config proxy.conf.json", "build": "ng build"},
        "dependencies": {
            "@angular/core": "^16.2.0", "@angular/common": "^16.2.0",
            "@angular/platform-browser": "^16.2.0", "@angular/platform-browser-dynamic": "^16.2.0",
            "@angular/router": "^16.2.0", "@angular/forms": "^16.2.0", "@angular/compiler": "^16.2.0",
            "rxjs": "^7.8.0", "zone.js": "~0.13.0",
        },
        "devDependencies": {
            "@angular/cli": "^16.2.4", "@angular/compiler-cli": "^16.2.4",
            "@angular-devkit/build-angular": "^16.2.4", "typescript": "~5.1.0",
        },
    }, indent=2) + "\n"

    return {
        "package.json": package_json,
        "angular.json": angular_json,
        "tsconfig.json": tsconfig,
        "proxy.conf.json": proxy_conf,
        "src/index.html": index_html,
        "src/main.ts": main_ts,
        "src/app/app.component.ts": app_component_ts,
        "src/app/app.routes.ts": routes_ts,
        ".gitignore": "node_modules/\ndist/\n",
    }


def _flutter_scaffold(project, screens: list[dict]) -> dict:
    """Structural scaffold only — no dart/flutter SDK available in this environment to
    compile-test it. Each screen's page_component.ext widget class is forced to
    ScreenPage via FRONTEND_CONVENTIONS (ai_service.py) so main.dart can reference it by
    a known name; every screen imports its own file under its own alias (Dart namespaces
    by library/file), so the identical class name across screens causes no collisions.
    Unlike the JS frameworks, there's no dev-proxy equivalent for /api calls — see the
    README caveat in _FRONTEND_RUN_INSTRUCTIONS."""
    imports = "\n".join(
        "import '../" + s["slug"] + "/page_component.dart' as " + _frontend_import_alias(s["slug"]) + ";"
        for s in screens
    )
    routes = ",\n        ".join(
        "'/" + s["slug"] + "': (context) => " + _frontend_import_alias(s["slug"]) + ".ScreenPage()"
        for s in screens
    )
    nav_buttons = "\n            ".join(
        "ElevatedButton(onPressed: () => Navigator.pushNamed(context, '/" + s["slug"] + "'), "
        "child: Text(" + json.dumps(s["name"]) + ")),"
        for s in screens
    )

    main_dart = (
        "import 'package:flutter/material.dart';\n"
        + imports + "\n\n"
        "void main() {\n"
        "  runApp(const MyApp());\n"
        "}\n\n"
        "class MyApp extends StatelessWidget {\n"
        "  const MyApp({super.key});\n\n"
        "  @override\n"
        "  Widget build(BuildContext context) {\n"
        "    return MaterialApp(\n"
        "      title: " + json.dumps(project.name) + ",\n"
        "      initialRoute: '/',\n"
        "      routes: {\n"
        "        '/': (context) => const HomePage(),\n"
        "        " + routes + "\n"
        "      },\n"
        "    );\n"
        "  }\n"
        "}\n\n"
        "class HomePage extends StatelessWidget {\n"
        "  const HomePage({super.key});\n\n"
        "  @override\n"
        "  Widget build(BuildContext context) {\n"
        "    return Scaffold(\n"
        "      appBar: AppBar(title: Text(" + json.dumps(project.name) + ")),\n"
        "      body: Center(\n"
        "        child: Column(\n"
        "          mainAxisSize: MainAxisSize.min,\n"
        "          children: [\n"
        "            " + nav_buttons + "\n"
        "          ],\n"
        "        ),\n"
        "      ),\n"
        "    );\n"
        "  }\n"
        "}\n"
    )
    pubspec = (
        "name: " + _slugify(project.name).lower().replace("-", "_") + "\n"
        "description: Generated by Text Dev IDE.\n"
        "publish_to: 'none'\n"
        "version: 1.0.0+1\n\n"
        "environment:\n"
        "  sdk: '>=3.0.0 <4.0.0'\n\n"
        "dependencies:\n"
        "  flutter:\n"
        "    sdk: flutter\n"
        "  http: ^1.2.0\n\n"
        "dev_dependencies:\n"
        "  flutter_test:\n"
        "    sdk: flutter\n\n"
        "flutter:\n"
        "  uses-material-design: true\n"
    )
    return {
        "pubspec.yaml": pubspec,
        "lib/main.dart": main_dart,
        ".gitignore": ".dart_tool/\nbuild/\n",
    }


def _html_scaffold(project, screens: list[dict]) -> dict:
    """No build tooling needed — preview/{slug}.html files (already pushed by the
    per-screen loop in build_push_files) are already complete, standalone, runnable
    pages. This is just a directory page over them."""
    links = "\n".join(
        '    <li><a href="preview/' + s["slug"] + '.html">' + s["name"] + "</a></li>" for s in screens
    )
    index_html = (
        "<!doctype html>\n"
        '<html lang="en">\n'
        "<head><meta charset=\"UTF-8\"><title>" + project.name + "</title></head>\n"
        "<body>\n"
        "  <h1>" + project.name + "</h1>\n"
        "  <ul>\n"
        + links + "\n"
        "  </ul>\n"
        "</body>\n"
        "</html>\n"
    )
    return {"index.html": index_html}


def _frontend_scaffold(project, frontend_screens: list[dict]) -> dict:
    """Deterministic (non-AI) package manifest + build config + entry point + a router
    wiring every screen's page_component into real navigation — the frontend equivalent
    of _backend_scaffold, generated once per push. frontend_screens: [{"slug", "name",
    "has_page_component", "has_preview"}, ...] accumulated in build_push_files()."""
    lang = project.frontend_language or "React"
    if lang == "HTML/CSS":
        return _html_scaffold(project, [s for s in frontend_screens if s["has_preview"]])
    screens = [s for s in frontend_screens if s["has_page_component"]]
    dispatch = {
        "Next.js": _nextjs_scaffold,
        "Vue": _vue_scaffold,
        "Angular": _angular_scaffold,
        "Flutter": _flutter_scaffold,
        "Svelte": _svelte_scaffold,
    }
    return dispatch.get(lang, _react_scaffold)(project, screens)


async def create_repo(token: str, name: str, description: str = "") -> dict:
    slug = _slugify(name)
    async with httpx.AsyncClient(timeout=20) as client:
        res = await client.post(
            f"{GITHUB_API}/user/repos",
            headers=_headers(token),
            json={"name": slug, "description": description, "private": True, "auto_init": True},
        )
        if res.status_code == 422:
            # Usually means the repo already exists — try to fetch it.
            me = await client.get(f"{GITHUB_API}/user", headers=_headers(token))
            if me.status_code != 200:
                raise RuntimeError(f"Invalid GitHub token ({me.status_code}). Check the token in Settings.")
            username = me.json().get("login")
            existing = await client.get(f"{GITHUB_API}/repos/{username}/{slug}", headers=_headers(token))
            if existing.status_code == 200:
                data = existing.json()
                return {"name": slug, "html_url": data["html_url"], "full_name": data["full_name"]}
            # 422 for some other reason — surface GitHub's message.
            msg = res.json().get("message", res.text)
            raise RuntimeError(f"Could not create repo '{slug}': {msg}")
        if res.status_code in (401, 403, 404):
            try:
                msg = res.json().get("message", res.text)
            except Exception:
                msg = res.text
            raise RuntimeError(
                f"GitHub rejected the token ({res.status_code}: {msg}). "
                "Make sure it is a valid Personal Access Token with 'repo' scope."
            )
        res.raise_for_status()
        data = res.json()
        return {"name": slug, "html_url": data["html_url"], "full_name": data["full_name"]}


async def push_files(token: str, full_name: str, files: dict, commit_message: str = "Update from Text Dev IDE") -> None:
    """Push multiple files to a repo. files = {path: content_str}"""
    errors = []
    async with httpx.AsyncClient(timeout=30) as client:
        for path, content in files.items():
            encoded = base64.b64encode(content.encode()).decode()
            # Check if file exists to get its SHA
            check = await client.get(f"{GITHUB_API}/repos/{full_name}/contents/{path}", headers=_headers(token))
            sha = check.json().get("sha") if check.status_code == 200 else None
            payload = {"message": commit_message, "content": encoded}
            if sha:
                payload["sha"] = sha
            res = await client.put(
                f"{GITHUB_API}/repos/{full_name}/contents/{path}",
                headers=_headers(token),
                json=payload,
            )
            if res.status_code not in (200, 201):
                try:
                    detail = res.json().get("message", res.text)
                except Exception:
                    detail = res.text
                errors.append(f"{path} ({res.status_code}: {detail})")

    if errors:
        # Surface the real GitHub failure instead of silently reporting success.
        raise RuntimeError("GitHub rejected some files: " + "; ".join(errors[:5]))


def build_push_files(project) -> tuple:
    """
    Builds TWO separate file sets for TWO separate repos:

    BACKEND repo root                    FRONTEND repo root
    ├── README.md                        ├── README.md
    ├── (entrypoint + manifest,          ├── ui/         (screen XML)
    │    per-language — see              ├── preview/    (reference HTML, not runnable)
    │    _backend_scaffold)              └── {screen}/   (api_service + page_component)
    ├── schema/      (table XML)
    ├── validations/ (rules text)
    ├── db-design/   (SQL per table)
    ├── api-contracts/ (JSON per screen)
    ├── common-library/ (entity/validation code, one file per entity)
    └── (routes/models per screen, in each language's idiomatic layout —
         see _backend_file_path)

    Returns (backend_files, frontend_files, screen_names).
    """
    backend_files, frontend_files = {}, {}
    ext = EXT.get(project.language, "txt")

    backend_readme = f"# {project.name} — Backend\n\n"
    frontend_readme = f"# {project.name} — Frontend\n\n"
    if project.description:
        backend_readme += f"{project.description}\n\n"
        frontend_readme += f"{project.description}\n\n"
    backend_readme += f"**Language:** {project.language}\n\n"
    backend_readme += "## Structure\n"
    backend_readme += "- `schema/` — database table XML definitions (one per table)\n"
    backend_readme += "- `validations/` — validation rules\n"
    backend_readme += "- `db-design/` — SQL files (one per table)\n"
    backend_readme += "- `api-contracts/` — API contract JSON per screen\n"
    backend_readme += f"- `common-library/` — entity/validation code ({project.language}), one file per entity\n"
    backend_readme += "- routes/models per screen, laid out per language convention (Maven for Java, Controllers/Models for C#, routes/ + models/ for Node, etc.)\n"
    backend_readme += "- an entrypoint (main.py / Application.java / index.js / Program.cs / main.go / app.rb / index.php) and dependency manifest are generated so this repo runs as-is\n\n"
    backend_readme += "_Generated by [Text Dev IDE](https://textdevide.netlify.app)_\n"

    frontend_lang = project.frontend_language or "React"
    frontend_readme += f"**Framework:** {frontend_lang}\n\n"
    frontend_readme += "## Structure\n"
    frontend_readme += "- `ui/` — screen XML definitions (one per screen)\n"
    frontend_readme += "- `preview/` — reference preview HTML (not the runnable app)\n"
    frontend_readme += f"- `{{screen}}/` — API service + page component per screen, wired together by the scaffold below\n"
    if frontend_lang == "HTML/CSS":
        frontend_readme += "- `index.html` — links to every screen under `preview/`\n\n"
    else:
        frontend_readme += (
            "- a dependency manifest, build config, entry point, and a router/nav wiring "
            "every screen together are generated so this repo runs as-is\n\n"
        )
    frontend_readme += f"## Run\n{_FRONTEND_RUN_INSTRUCTIONS.get(frontend_lang, _FRONTEND_RUN_INSTRUCTIONS['React'])}\n\n"
    frontend_readme += "_Generated by [Text Dev IDE](https://textdevide.netlify.app)_\n"

    backend_files["README.md"] = backend_readme
    frontend_files["README.md"] = frontend_readme

    if project.validation_rules:
        backend_files["validations/rules.md"] = f"# Validation Rules\n\n{project.validation_rules}\n"

    # common-library/ — entity + validation code, split into real individual files
    if project.validation_code:
        for f in _parse_bundle(project.validation_code, f"validation.{ext}"):
            backend_files[f"common-library/{f['name']}"] = f["code"]

    # Shared auth module — only present once a screen using <auth> has been generated (see
    # gen_screen_xml). Lands at a fixed, language-specific path every other secured screen's
    # generated routes import from (_auth_module_path / AUTH_CONVENTIONS in ai_service.py).
    has_auth = bool(project.auth_code)
    if has_auth:
        backend_files[_auth_module_path(project.language)] = project.auth_code

    # Real live database — the baseline for every project with a schema, not an opt-in like auth.
    # Python's engine/session (database.py) and ORM models (db_models.py) are both deterministic
    # (see ai_service.py) since neither needs per-project judgment; other languages' equivalents
    # are AI-generated once per project the same way the auth module is (see routes/projects.py).
    if project.entities:
        try:
            entities = json.loads(project.entities)
        except Exception:
            entities = None
        if entities and entities.get("tables"):
            if project.language == "Python":
                backend_files["database.py"] = PYTHON_DATABASE_MODULE
                backend_files["db_models.py"] = generate_sqlalchemy_models(entities)
            elif project.db_code:
                db_path, _ = _DB_MODULE_PATH.get(project.language, (f"db.{EXT.get(project.language, 'txt')}", None))
                backend_files[db_path] = project.db_code

    # Shared email module — only present once a screen detected as actually sending an email has
    # been generated (see gen_screen_api). Python's is deterministic; other languages' are
    # AI-generated once per project, same shape as the auth/db modules above.
    if project.email_code:
        if project.language == "Python":
            backend_files[_email_module_path(project.language)] = PYTHON_EMAIL_SERVICE_MODULE
        else:
            backend_files[_email_module_path(project.language)] = project.email_code

    # .env.example — documents the real config knobs a generated project actually reads.
    env_lines = []
    if project.entities:
        env_lines.append("# Optional — defaults to a local SQLite file if unset\nDATABASE_URL=")
    if project.email_code:
        env_lines.append(
            "# Required for real email sending\nSMTP_HOST=\nSMTP_PORT=587\nSMTP_USER=\nSMTP_PASSWORD=\nSMTP_FROM="
        )
    if env_lines:
        backend_files[".env.example"] = "\n\n".join(env_lines) + "\n"

    # schema/ — one XML per database table; db-design/ — one SQL file per table
    if project.entities:
        try:
            entities = json.loads(project.entities)
            for table in entities.get("tables", []):
                tname = table["name"]

                xml_lines = [f'<?xml version="1.0" encoding="UTF-8"?>',
                             f'<entity name="{tname}">',
                             '  <columns>']
                for col in table.get("columns", []):
                    pk = str(col.get("pk", False)).lower()
                    fk = col.get("fk") or "null"
                    xml_lines.append(
                        f'    <column name="{col["name"]}" type="{col.get("type","VARCHAR")}" pk="{pk}" fk="{fk}"/>'
                    )
                xml_lines += ['  </columns>', '</entity>']
                backend_files[f"schema/{tname}.xml"] = "\n".join(xml_lines)

                cols = []
                fk_constraints = []
                for col in table.get("columns", []):
                    col_type = col.get("type", "VARCHAR(255)")
                    pk = " PRIMARY KEY" if col.get("pk") else ""
                    cols.append(f"  {col['name']} {col_type}{pk}")
                    if col.get("fk"):
                        ref_table, ref_col = (col["fk"].split(".") + ["id"])[:2]
                        fk_constraints.append(
                            f"  FOREIGN KEY ({col['name']}) REFERENCES {ref_table}({ref_col})"
                        )
                all_cols = cols + fk_constraints
                sql = f"-- {tname} table\nCREATE TABLE IF NOT EXISTS {tname} (\n" + ",\n".join(all_cols) + "\n);\n"
                backend_files[f"db-design/{tname}.sql"] = sql
        except Exception:
            pass

    # screens
    screen_names = []
    backend_screen_slugs = []  # screens that actually got a routes file placed — feeds the entrypoint wiring
    frontend_screens = []      # [{"slug", "name", "has_page_component", "has_preview"}, ...] — feeds the frontend scaffold's router wiring
    if project.ui_screens:
        try:
            screens = json.loads(project.ui_screens)
            for screen in screens:
                slug = _safe_ident(screen.get("name", "screen"))
                screen_names.append(screen.get("name", slug))
                got_page_component = False

                if screen.get("xml"):
                    frontend_files[f"ui/{slug}.xml"] = screen["xml"]

                if screen.get("html"):
                    frontend_files[f"preview/{slug}.html"] = screen["html"]

                # Split the generated API bundle: backend (routes/models) -> backend repo,
                # in each language's idiomatic layout; frontend (api_service/page_component)
                # -> frontend repo; contracts -> backend repo.
                if screen.get("api"):
                    parsed = _parse_bundle(screen["api"], f"{slug}.{ext}")
                    got_routes = False
                    for idx, f in enumerate(parsed):
                        name, code = f["name"], f["code"]
                        low = name.lower()
                        if _CONTRACTS_FILE_RE.search(name):
                            backend_files[f"api-contracts/{slug}.json"] = code
                        elif _FRONTEND_FILE_RE.match(name):
                            category = "page_component" if low.startswith("page_component") else "api_service"
                            frontend_files[_frontend_file_path(project.frontend_language, category, slug)] = code
                            if category == "page_component":
                                got_page_component = True
                        elif _BACKEND_FILE_RE.match(name):
                            category = "routes" if low.startswith("routes") else "models"
                            backend_files[_backend_file_path(project.language, category, slug, name)] = code
                            if category == "routes":
                                got_routes = True
                        elif idx == _POSITION_BACKEND_ROUTES:
                            backend_files[_backend_file_path(project.language, "routes", slug, name)] = code
                            got_routes = True
                        elif idx == _POSITION_BACKEND_MODELS:
                            backend_files[_backend_file_path(project.language, "models", slug, name)] = code
                        elif idx in (_POSITION_FRONTEND_API_SERVICE, _POSITION_FRONTEND_PAGE_COMPONENT):
                            category = "page_component" if idx == _POSITION_FRONTEND_PAGE_COMPONENT else "api_service"
                            frontend_files[_frontend_file_path(project.frontend_language, category, slug)] = code
                            if category == "page_component":
                                got_page_component = True
                        else:
                            backend_files[f"{slug}/{name}"] = code
                    if got_routes:
                        backend_screen_slugs.append(slug)

                frontend_screens.append({
                    "slug": slug,
                    "name": screen.get("name", slug),
                    "has_page_component": got_page_component,
                    "has_preview": bool(screen.get("html")),
                })
        except Exception:
            pass

    backend_files.update(_backend_scaffold(project, backend_screen_slugs))
    frontend_files.update(_frontend_scaffold(project, frontend_screens))

    return backend_files, frontend_files, screen_names


def build_commit_message(project, screen_names: list) -> str:
    parts = []
    if project.validation_code:
        parts.append("validation code")
    if screen_names:
        names = ", ".join(screen_names[:3])
        suffix = f" +{len(screen_names) - 3} more" if len(screen_names) > 3 else ""
        parts.append(f"{len(screen_names)} screen{'s' if len(screen_names) > 1 else ''}: {names}{suffix}")
    body = " and ".join(parts) if parts else "project files"
    return f"Update {body}"
