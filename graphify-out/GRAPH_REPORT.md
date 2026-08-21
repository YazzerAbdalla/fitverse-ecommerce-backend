# Graph Report - mini-e-commerce  (2026-08-21)

## Corpus Check
- 146 files · ~147,875 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 706 nodes · 1068 edges · 113 communities (34 shown, 79 thin omitted)
- Extraction: 92% EXTRACTED · 8% INFERRED · 0% AMBIGUOUS · INFERRED: 82 edges (avg confidence: 0.85)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- Cart module
- Auth module
- Order module
- Src
- Package
- Documentation
- 
- Tsconfig
- Products module
- Order module
- Spec Kit config
- Spec Kit config
- Products module
- Inventory module
- Products module
- Documentation
- Documentation
- Package / amqp
- Products module
- Spec Kit config
- Ref
- Spec Kit config
- Package / eslint
- Nest
- Products module
- 
- AGENTS.md / Documentation
- Products module
- 
- Spec Kit config
- Products module
- Spec Kit config
- Spec Kit config
- 
- 
- Amqplib / package
- Apollo / package
- As / package
- Cache / package
- Cache / package
- Class / package
- Infra (compose) / Documentation
- Infra (compose) / Documentation
- Dotenv / package
- Eslint / package
- Eslint / package
- Eslint / package
- Eslint / package
- Globals / package
- Graphql / package
- Ioredis / package
- Keyv / package
- Nestjs / package
- Nestjs / package
- Nestjs / package
- Nestjs / package
- Nestjs / package
- Nestjs / package
- Nestjs / package
- Nestjs / package
- Nestjs / package
- Nestjs / package
- Nestjs / package
- Nestjs / package
- Nestjs / package
- Nestjs / package
- Nestjs / package
- Package / passport
- Package / passport
- Package / pg
- Package / reflect
- Package / rxjs
- Package / slugify
- Package / typeorm
- Package / prettier
- Package / source
- Package / supertest
- Package / ts
- Package / ts
- Package / tsconfig
- Package / types
- Package / types
- Package / types
- Package / types
- Package / types
- Package / types
- Package / typescript
- Package / typescript
- 
- 
- 
- 
- 
- 
- 
- 
- 
- 
- 
- AGENTS.md
- Infra (compose)
- Documentation
- Documentation
- Documentation
- Documentation
- Documentation
- README

## God Nodes (most connected - your core abstractions)
1. `Product` - 27 edges
2. `User` - 23 edges
3. `compilerOptions` - 23 edges
4. `ProductsService` - 21 edges
5. `CartService` - 19 edges
6. `Cart` - 19 edges
7. `CartItem` - 18 edges
8. `Extension Hook Mechanism` - 16 edges
9. `Order` - 15 edges
10. `CartController` - 14 edges

## Surprising Connections (you probably didn't know these)
- `Spec Kit Git Commit Command` --semantically_similar_to--> `Git Extension Commit Command Template`  [INFERRED] [semantically similar]
  .opencode/command/speckit.git.commit.md → .specify/extensions/git/commands/speckit.git.commit.md
- `Spec Kit Git Feature Command` --semantically_similar_to--> `Git Extension Feature Command Template`  [INFERRED] [semantically similar]
  .opencode/command/speckit.git.feature.md → .specify/extensions/git/commands/speckit.git.feature.md
- `Spec Kit Git Initialize Command` --semantically_similar_to--> `Git Extension Initialize Command Template`  [INFERRED] [semantically similar]
  .opencode/command/speckit.git.initialize.md → .specify/extensions/git/commands/speckit.git.initialize.md
- `auth module (REST)` --conceptually_related_to--> `Module boundary enforcement`  [INFERRED]
  docs/architecture/modules.md → AGENTS.md
- `cart module (REST)` --conceptually_related_to--> `Module boundary enforcement`  [INFERRED]
  docs/architecture/modules.md → AGENTS.md

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Spec Kit Core Workflow** — _opencode_command_speckit_specify, _opencode_command_speckit_clarify, _opencode_command_speckit_plan, _opencode_command_speckit_tasks, _opencode_command_speckit_analyze, _opencode_command_speckit_implement, _opencode_command_speckit_checklist, _opencode_command_speckit_constitution, _opencode_command_speckit_taskstoissues [EXTRACTED 1.00]
- **Git Extension Command Set** — git_extension, _specify_extensions_git_readme, _opencode_command_speckit_git_commit, _opencode_command_speckit_git_feature, _opencode_command_speckit_git_initialize, _opencode_command_speckit_git_remote, _opencode_command_speckit_git_validate, _specify_extensions_git_commands_speckit_git_commit, _specify_extensions_git_commands_speckit_git_feature, _specify_extensions_git_commands_speckit_git_initialize, _specify_extensions [EXTRACTED 1.00]
- **Extension Hook Wiring** — extension_hook_mechanism, _specify_extensions, _opencode_command_speckit_constitution, _opencode_command_speckit_specify, _opencode_command_speckit_clarify, _opencode_command_speckit_plan, _opencode_command_speckit_tasks, _opencode_command_speckit_implement, _opencode_command_speckit_checklist, _opencode_command_speckit_analyze, _opencode_command_speckit_taskstoissues [EXTRACTED 1.00]
- **Architecture & API documentation set** — docs_architecture_modules, docs_architecture_data_flow, docs_architecture_inventory_reservation, docs_api_conventions [INFERRED 0.85]
- **Spec Kit artifact templates** — _specify_templates_spec_template, _specify_templates_plan_template, _specify_templates_tasks_template, _specify_templates_checklist_template, _specify_templates_constitution_template [INFERRED 0.90]
- **Git Branching Workflow extension** — _specify_extensions_git_extension, _specify_extensions_git_commands_speckit_git_validate, _specify_extensions_git_commands_speckit_git_remote, _specify_extensions_git_git_config, _specify_extensions_git_config_template [INFERRED 0.90]
- **Accepted Architecture Decision Records** — docs_decisions_0001_modular_monolith_nestjs, docs_decisions_0002_postgres_typeorm, docs_decisions_0003_redis_cache_only, docs_decisions_0004_rabbitmq_async, docs_decisions_0005_jwt_auth, docs_decisions_0006_graphql_products [EXTRACTED 1.00]
- **Agent Skills (Backend Guidance)** — skills_backend_development_skill, skills_code_review_skill, skills_database_skill, skills_system_design_skill, skills_testing_skill, skills_spec_driven_development_skill [EXTRACTED 1.00]
- **Inventory / Reservation Target Design** — docs_decisions_0007_inventory_reservation_inventory_reservation_model, docs_plan_inventory_entity, docs_plan_reservation_entity, docs_plan_reservation_lifecycle, docs_database_overview_pessimistic_write_lock [INFERRED 0.95]

## Communities (113 total, 79 thin omitted)

### Community 0 - "Cart module"
Cohesion: 0.06
Nodes (45): ApiOperation, ApiPropertyOptional, CurrentUser, CartController, ApiBearerAuth, ApiResponse, ApiTags, Body (+37 more)

### Community 1 - "Auth module"
Cohesion: 0.05
Nodes (37): ApiBody, IsString, MinLength, Request, AuthController, ApiResponse, ApiTags, Body (+29 more)

### Community 2 - "Order module"
Cohesion: 0.08
Nodes (21): Auth(), ROLESKEY, JwtGuard, Injectable, RolesGuard, Injectable, JwtPayloadProps, CreateOrderDto (+13 more)

### Community 3 - "Src"
Cohesion: 0.07
Nodes (22): Catch, AppController, Controller, Get, AppModule, Module, AppService, Inject (+14 more)

### Community 4 - "Package"
Cohesion: 0.06
Nodes (32): author, description, jest, collectCoverageFrom, coverageDirectory, moduleFileExtensions, rootDir, testEnvironment (+24 more)

### Community 5 - "Documentation"
Cohesion: 0.13
Nodes (30): Architecture Overview, Database Overview, Pessimistic Row Locking for Overselling Prevention, Database Relationships, ADR 0001 — NestJS Modular Monolith, Modular Monolith Architecture Principle, ADR 0002 — PostgreSQL + TypeORM, PostgreSQL as System of Record (+22 more)

### Community 6 - ""
Cohesion: 0.16
Nodes (26): Spec Kit Analyze Command, Spec Kit Checklist Command, Spec Kit Clarify Command, Spec Kit Constitution Command, Spec Kit Git Commit Command, Spec Kit Git Feature Command, Spec Kit Git Initialize Command, Spec Kit Git Remote Command (+18 more)

### Community 7 - "Tsconfig"
Cohesion: 0.08
Nodes (23): compilerOptions, allowSyntheticDefaultImports, baseUrl, declaration, emitDecoratorMetadata, esModuleInterop, experimentalDecorators, forceConsistentCasingInFileNames (+15 more)

### Community 8 - "Products module"
Cohesion: 0.17
Nodes (6): Args, Mutation, Resolver, ProductsResolver, ProductsService, Injectable

### Community 9 - "Order module"
Cohesion: 0.13
Nodes (16): JoinTable, ManyToMany, Order, Column, CreateDateColumn, Entity, ManyToOne, PrimaryGeneratedColumn (+8 more)

### Community 10 - "Spec Kit config"
Cohesion: 0.14
Nodes (5): _extract_highest_number(), get_highest_from_branches(), create-new-feature.sh script, has_git(), git-common.sh script

### Community 11 - "Spec Kit config"
Cohesion: 0.23
Nodes (11): Find-FeatureDirByPrefix(), Find-SpecifyRoot(), Get-CurrentBranch(), Get-FeatureDirFromBranchPrefixOrExit(), Get-FeaturePathsEnv(), Get-Python3Command(), Get-RepoRoot(), Get-SpecKitEffectiveBranchName() (+3 more)

### Community 12 - "Products module"
Cohesion: 0.14
Nodes (13): Check, Product, Column, CreateDateColumn, Entity, Field, Index, ObjectType (+5 more)

### Community 13 - "Inventory module"
Cohesion: 0.19
Nodes (4): InventoryService, Injectable, ProductsModule, Module

### Community 14 - "Products module"
Cohesion: 0.21
Nodes (9): IsNumber, CreateProductInput, Field, InputType, IsNotEmpty, MaxLength, DeleteResponse, Field (+1 more)

### Community 15 - "Documentation"
Cohesion: 0.18
Nodes (12): InventoryService sole stock writer, Module boundary enforcement, Offset pagination response shape, REST vs GraphQL API split, Inventory entity (intended), Product entity, auth module (REST), cart module (REST) (+4 more)

### Community 16 - "Documentation"
Cohesion: 0.22
Nodes (10): AGENTS.md project rules, Global AllExceptionsFilter, JwtGuard + RolesGuard + Auth decorator, Global ValidationPipe, API conventions, Architecture data flow, Inventory & reservation intended design, Inventory invariant: available = stock - reserved_amount (+2 more)

### Community 17 - "Package / amqp"
Cohesion: 0.22
Nodes (9): amqp-connection-manager, bcrypt, class-validator, @nestjs/microservices, dependencies, amqp-connection-manager, bcrypt, class-validator (+1 more)

### Community 18 - "Products module"
Cohesion: 0.25
Nodes (6): ArgsType, Query, PaginationArgs, Field, IsOptional, Min

### Community 19 - "Spec Kit config"
Cohesion: 0.39
Nodes (7): ConvertTo-CleanBranchName(), Get-BranchName(), Get-HighestNumberFromBranches(), Get-HighestNumberFromNames(), Get-HighestNumberFromRemoteRefs(), Get-HighestNumberFromSpecs(), Get-NextBranchNumber()

### Community 20 - "Ref"
Cohesion: 0.25
Nodes (7): dist, node_modules, **/*spec.ts, test, ./tsconfig.json, exclude, extends

### Community 21 - "Spec Kit config"
Cohesion: 0.46
Nodes (7): ConvertTo-CleanBranchName(), Get-BranchName(), Get-HighestNumberFromBranches(), Get-HighestNumberFromNames(), Get-HighestNumberFromRemoteRefs(), Get-HighestNumberFromSpecs(), Get-NextBranchNumber()

### Community 22 - "Package / eslint"
Cohesion: 0.29
Nodes (7): eslint, jest, devDependencies, eslint, jest, ts-loader, ts-loader

### Community 23 - "Nest"
Cohesion: 0.33
Nodes (5): collection, compilerOptions, deleteOutDir, $schema, sourceRoot

### Community 25 - ""
Cohesion: 0.50
Nodes (5): Detect Git Remote URL command, Validate Feature Branch command, Git extension config template, Git Branching Workflow extension manifest, Git extension installed config

### Community 26 - "AGENTS.md / Documentation"
Cohesion: 0.40
Nodes (5): PostgreSQL as authoritative source of truth, Transactional write + pessimistic lock pattern, PostgreSQL 17 service, Intended checkout/reservation flow, Reservation entity (intended)

### Community 27 - "Products module"
Cohesion: 0.60
Nodes (4): PaginationMeta, ProductPagination, Field, ObjectType

### Community 28 - ""
Cohesion: 0.50
Nodes (4): Implementation plan template, Feature specification template, Tasks template, Full SDD Cycle (specify to plan to tasks to implement)

## Knowledge Gaps
- **171 isolated node(s):** `auto-commit.sh script`, `git-common.sh script`, `initialize-repo.sh script`, `$schema`, `collection` (+166 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **79 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `User` connect `Auth module` to `Cart module`, `Order module`, `Order module`, `Products module`?**
  _High betweenness centrality (0.037) - this node is a cross-community bridge._
- **Why does `dependencies` connect `Package / amqp` to `Package`, `Amqplib / package`, `Apollo / package`, `As / package`, `Cache / package`, `Cache / package`, `Class / package`, `Dotenv / package`, `Graphql / package`, `Ioredis / package`, `Keyv / package`, `Nestjs / package`, `Nestjs / package`, `Nestjs / package`, `Nestjs / package`, `Nestjs / package`, `Nestjs / package`, `Nestjs / package`, `Nestjs / package`, `Nestjs / package`, `Nestjs / package`, `Nestjs / package`, `Nestjs / package`, `Package / passport`, `Package / passport`, `Package / pg`, `Package / reflect`, `Package / rxjs`, `Package / slugify`, `Package / typeorm`?**
  _High betweenness centrality (0.031) - this node is a cross-community bridge._
- **Why does `Product` connect `Products module` to `Cart module`, `Order module`, `Inventory module`, `Products module`, `Products module`, `Products module`?**
  _High betweenness centrality (0.026) - this node is a cross-community bridge._
- **What connects `auto-commit.sh script`, `git-common.sh script`, `initialize-repo.sh script` to the rest of the system?**
  _171 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Cart module` be split into smaller, more focused modules?**
  _Cohesion score 0.056140350877192984 - nodes in this community are weakly interconnected._
- **Should `Auth module` be split into smaller, more focused modules?**
  _Cohesion score 0.05499735589635114 - nodes in this community are weakly interconnected._
- **Should `Order module` be split into smaller, more focused modules?**
  _Cohesion score 0.07755102040816327 - nodes in this community are weakly interconnected._