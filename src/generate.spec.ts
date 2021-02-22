import assert from 'assert';
import expect from 'expect';
import { isEqual } from 'lodash';
import ololog from 'ololog';
import { Project, PropertyDeclaration, SourceFile } from 'ts-morph';
import { equals } from 'typescript-equals';

import { generate } from './generate';
import { reexport } from './generator-pipelines';
import { generatorOptions, getImportDeclarations, stringContains } from './testing';

const log = ololog.configure({
    stringify: {
        maxStringLength: Number.MAX_VALUE,
        maxObjectLength: Number.MAX_VALUE,
        maxArrayLength: Number.MAX_VALUE,
        maxDepth: Number.MAX_VALUE,
        maxErrorMessageLength: Number.MAX_VALUE,
    },
});

describe('main generate', () => {
    let property: PropertyDeclaration | undefined;
    let sourceFile: SourceFile | undefined;
    let sourceFiles: SourceFile[];
    let sourceText: string;
    let project: Project;
    let resultGeneratorOptions: any;
    async function getResult(args: { schema: string; options?: string[] }) {
        const { schema, options } = args;
        resultGeneratorOptions = {
            ...(await generatorOptions(schema, options)),
            fileExistsSync: () => false,
        };
        project = await generate(resultGeneratorOptions);
        sourceFiles = project.getSourceFiles();
    }

    it('smoke one', async () => {
        await getResult({
            schema: `
            model User {
              id        Int      @id
            }
            `,
        });
        const filePaths = sourceFiles.map(s => String(s.getFilePath()));
        expect(filePaths).not.toHaveLength(0);
    });

    it('smoke many', async () => {
        await getResult({
            schema: `model User {
              id        Int      @id
              name      String?
              profile   Profile?
              comments  Comment[]
              role      Role
            }
            model Profile {
                id        Int      @id
                sex       Boolean?
            }
            model Comment {
                id        Int      @id
            }
            enum Role {
                USER
            }
            `,
        });
        const filePaths = sourceFiles.map(s => String(s.getFilePath()));
        expect(filePaths).not.toHaveLength(0);
    });

    it('relations models', async () => {
        await getResult({
            schema: `
            model User {
              id        Int      @id
              posts     Post[]
            }
            model Post {
              id        Int      @id
              author    User?    @relation(fields: [authorId], references: [id])
              authorId  Int?
            }`,
        });
        sourceFile = sourceFiles.find(s =>
            s.getFilePath().toLowerCase().endsWith('/user.model.ts'),
        )!;
        assert(sourceFile, `File do not exists`);

        const property = sourceFile.getClass('User')?.getProperty('posts');
        assert(property, 'Property posts should exists');

        expect(property.getText()).toContain('@Field(() => [Post]');
        expect(property.getStructure().type).toEqual('Array<Post>');

        sourceFile = sourceFiles.find(s =>
            s.getFilePath().toLowerCase().endsWith('/post.model.ts'),
        )!;
        assert(sourceFile);
        sourceText = sourceFile.getText();
        stringContains(`import { User } from '../user/user.model'`, sourceText);
    });

    it('whereinput should be used in relation filter', async () => {
        await getResult({
            schema: `
            model User {
                id       String     @id
                articles Article[]  @relation("ArticleAuthor")
            }
            model Article {
                id        String @id
                author    User   @relation(name: "ArticleAuthor", fields: [authorId], references: [id])
                authorId  String
            }
            `,
        });
        sourceFile = sourceFiles.find(s =>
            s.getFilePath().toLowerCase().endsWith('/article-where.input.ts'),
        )!;
        assert(sourceFile, `File do not exists`);

        property = sourceFile.getClass('ArticleWhereInput')?.getProperty('author');
        assert(property, 'Property author should exists');

        assert.strictEqual(
            property.getStructure().decorators?.[0].arguments?.[0],
            '() => UserWhereInput',
            'Union type not yet supported, WhereInput should be used as more common',
        );

        const imports = sourceFile.getImportDeclarations().flatMap(d =>
            d.getNamedImports().map(index => ({
                name: index.getName(),
                specifier: d.getModuleSpecifierValue(),
            })),
        );
        assert(
            imports.find(({ name }) => name === 'UserWhereInput'),
            'UserWhereInput should be imported',
        );
    });

    it('generator option outputFilePattern', async () => {
        await getResult({
            schema: `model User {
                    id Int @id
                }`,
            options: [`outputFilePattern = "data/{type}/{name}.ts"`],
        });
        const filePaths = sourceFiles.map(s => String(s.getFilePath()));
        expect(filePaths).toContainEqual(
            expect.stringContaining('/data/model/user.ts'),
        );
    });

    it('output group by feature', async () => {
        await getResult({
            schema: `model User {
                    id Int @id
                }`,
        });
        const filePaths = new Set(sourceFiles.map(s => String(s.getFilePath())));
        expect(filePaths).toContainEqual('/user/user-where.input.ts');
        expect(filePaths).toContainEqual('/prisma/int-filter.input.ts');
    });

    it('generate enum file', async () => {
        await getResult({
            schema: `
                model User {
                  id    Int   @id
                }
            `,
        });
        const filePaths = sourceFiles.map(s => String(s.getFilePath()));
        expect(filePaths).toContain('/prisma/sort-order.enum.ts');
        // eslint-disable-next-line @typescript-eslint/no-non-null-asserted-optional-chain
        sourceText = sourceFiles
            .find(s => s.getFilePath().endsWith('sort-order.enum.ts'))
            ?.getText()!;
        assert(sourceText);
    });

    it('no nullable type', async () => {
        await getResult({
            schema: `
                model User {
                  id    Int   @id
                  countComments Int?
                }
            `,
        });
        for (const d of sourceFiles
            .flatMap(s => s.getClasses())
            .flatMap(d => d.getProperties())
            .flatMap(p => p.getDecorators())) {
            const argument = d.getCallExpression()?.getArguments()?.[0].getText();
            assert.notStrictEqual(argument, '() => null');
        }
    });

    it('user avg aggregate input', async () => {
        await getResult({
            schema: `
            model User {
              id     String      @id
              age    Int
            }
            `,
        });
        sourceFile = sourceFiles.find(s =>
            s.getFilePath().endsWith('user-avg-aggregate.input.ts'),
        );
        assert(sourceFile);
        const classDeclaration = sourceFile.getClass('UserAvgAggregateInput');
        assert(classDeclaration, 'class not found');
        const propertyDeclaration = classDeclaration.getProperty('age');
        assert(propertyDeclaration, 'age');
        const decorator = propertyDeclaration.getDecorator('Field');
        assert(decorator);
        const struct = decorator.getStructure();
        expect(struct.arguments?.[0]).toEqual('() => Boolean');
    });

    it('get rid of atomic number operations', async () => {
        await getResult({
            schema: `
            model User {
              id String @id
              age Int
              rating Float?
            }
            `,
            options: [`atomicNumberOperations = false`],
        });
        for (const file of [
            'float-field-update-operations.input.ts',
            'int-field-update-operations.input.ts',
            'string-field-update-operations.input.ts',
        ]) {
            assert(
                !sourceFiles.some(s => s.getFilePath().endsWith(file)),
                `File ${file} should not exists`,
            );
        }

        sourceFile = sourceFiles.find(s =>
            s.getFilePath().endsWith('user-update.input.ts'),
        );
        assert(sourceFile);

        const classDeclaration = sourceFile.getClass('UserUpdateInput');
        assert(classDeclaration);

        const id = classDeclaration.getProperty('id')?.getStructure();
        assert(id);
        assert.strictEqual(id.type, 'string');
        let args = classDeclaration
            .getProperty('id')
            ?.getDecorator('Field')
            ?.getArguments()
            .map(a => a.getText());
        assert.strictEqual(args?.[0], '() => String');

        const age = classDeclaration.getProperty('age')?.getStructure();
        assert(age);
        assert.strictEqual(age.type, 'number');
        args = classDeclaration
            .getProperty('age')
            ?.getDecorator('Field')
            ?.getArguments()
            .map(a => a.getText());
        assert.strictEqual(args?.[0], '() => Int');

        const rating = classDeclaration.getProperty('rating')?.getStructure();
        assert(rating);
        expect(rating.type).toEqual('number');
        args = classDeclaration
            .getProperty('rating')
            ?.getDecorator('Field')
            ?.getArguments()
            .map(a => a.getText());
        assert.strictEqual(args?.[0], '() => Float');
    });

    it('user args type', async () => {
        await getResult({
            schema: `
            model User {
              id String @id
              age Int
              rating Float?
            }
            `,
            options: [`atomicNumberOperations = false`],
        });
        for (const file of [
            'aggregate-user.args.ts',
            'find-many-user.args.ts',
            'find-unique-user.args.ts',
        ]) {
            assert(
                sourceFiles.find(s => s.getFilePath().endsWith(file)),
                `File ${file} should exists`,
            );
        }

        sourceFile = sourceFiles.find(s =>
            s.getFilePath().endsWith('aggregate-user.args.ts'),
        );
        assert(sourceFile);

        const classDeclaration = sourceFile.getClass('AggregateUserArgs');
        assert(classDeclaration);

        let struct = classDeclaration.getProperty('count')?.getStructure();
        let decoratorArguments = struct?.decorators?.[0].arguments;
        assert.strictEqual(decoratorArguments?.[0], '() => Boolean');

        struct = classDeclaration.getProperty('avg')?.getStructure();
        assert.strictEqual(struct?.type, 'UserAvgAggregateInput');
        decoratorArguments = struct.decorators?.[0].arguments;
        assert.strictEqual(decoratorArguments?.[0], '() => UserAvgAggregateInput');

        struct = classDeclaration.getProperty('sum')?.getStructure();
        assert.strictEqual(struct?.type, 'UserSumAggregateInput');
        decoratorArguments = struct.decorators?.[0].arguments;
        assert.strictEqual(decoratorArguments?.[0], '() => UserSumAggregateInput');

        struct = classDeclaration.getProperty('min')?.getStructure();
        assert.strictEqual(struct?.type, 'UserMinAggregateInput');
        decoratorArguments = struct.decorators?.[0].arguments;
        assert.strictEqual(decoratorArguments?.[0], '() => UserMinAggregateInput');

        struct = classDeclaration.getProperty('max')?.getStructure();
        assert.strictEqual(struct?.type, 'UserMaxAggregateInput');
        decoratorArguments = struct.decorators?.[0].arguments;
        assert.strictEqual(decoratorArguments?.[0], '() => UserMaxAggregateInput');

        const imports = getImportDeclarations(sourceFile);

        assert(imports.find(x => x.name === 'UserAvgAggregateInput'));
        assert(imports.find(x => x.name === 'UserSumAggregateInput'));
        assert(imports.find(x => x.name === 'UserMinAggregateInput'));
        assert(imports.find(x => x.name === 'UserMaxAggregateInput'));
    });

    it('aggregate output types', async () => {
        await getResult({
            options: [`atomicNumberOperations = false`],
            schema: `
            model User {
              id String @id
              age Int
              rating Float?
            }
            `,
        });
        sourceFile = sourceFiles.find(s =>
            s.getFilePath().endsWith('user-avg-aggregate.output.ts'),
        );
        assert(sourceFile);
        const classDeclaration = sourceFile.getClass('UserAvgAggregate');
        assert(classDeclaration);

        let struct = classDeclaration.getProperty('age')?.getStructure();
        let decoratorArguments = struct?.decorators?.[0].arguments;
        assert.strictEqual(decoratorArguments?.[0], '() => Float');

        struct = classDeclaration.getProperty('rating')?.getStructure();
        decoratorArguments = struct?.decorators?.[0].arguments;
        assert.strictEqual(decoratorArguments?.[0], '() => Float');
    });

    it('no combine scalar filters', async () => {
        await getResult({
            schema: `
            model User {
              id        Int      @id
              int       Int?
              str       String?
              bool      Boolean?
              date      DateTime?
            }
            `,
            options: [`combineScalarFilters = false`],
        });
        const userWhereInput = sourceFiles.find(s =>
            s.getFilePath().endsWith('user-where.input.ts'),
        );
        assert(userWhereInput);
        const fileImports = new Set(
            getImportDeclarations(userWhereInput).map(x => x.name),
        );
        assert(fileImports.has('StringNullableFilter'));
        assert(fileImports.has('IntNullableFilter'));
        assert(fileImports.has('DateTimeNullableFilter'));
    });

    it('combine scalar filters enabled', async () => {
        await getResult({
            schema: `
            model User {
              id        Int      @id
              int       Int?
              str1       String?
              str2       String
              bool1      Boolean?
              bool2      Boolean
              date1      DateTime?
              date2      DateTime
              f1      Float?
              f2      Float
              role1      Role?
              role2      Role
            }
            enum Role {
                USER
            }
            `,
            options: [`combineScalarFilters = true`],
        });
        const filePaths = sourceFiles.map(s => String(s.getFilePath()));
        for (const filePath of filePaths) {
            expect(filePath).not.toContain('nullable');
            expect(filePath).not.toContain('nested');
        }
        for (const sourceFile of sourceFiles) {
            for (const statement of getImportDeclarations(sourceFile)) {
                if (statement.name.includes('Nullable')) {
                    assert.fail(
                        `${sourceFile.getFilePath()} imports nullable ${
                            statement.name
                        }`,
                    );
                }
                if (statement.name.includes('Nested')) {
                    assert.fail(
                        `${sourceFile.getFilePath()} imports nested ${statement.name}`,
                    );
                }
            }
        }
    });

    it('option atomicNumberOperations false', async () => {
        await getResult({
            schema: `
            model User {
              id        String      @id
              int1      Int
              int2      Int?
              f1        Float?
              f2        Float
              role1     Role?
              role2     Role
            }
            enum Role {
                USER
            }
            `,
            options: [`atomicNumberOperations = false`],
        });
        expect(sourceFiles.length).toBeGreaterThan(0);
        for (const sourceFile of sourceFiles) {
            for (const classDeclaration of sourceFile.getClasses()) {
                if (
                    classDeclaration.getName()?.endsWith('FieldUpdateOperationsInput')
                ) {
                    throw new Error(
                        `Class should not exists ${classDeclaration.getName()!}`,
                    );
                }
            }
        }
        for (const struct of sourceFiles
            .flatMap(s => s.getClasses())
            .filter(c =>
                ['UserUpdateInput', 'UserUpdateManyMutationInput'].includes(
                    c.getName()!,
                ),
            )
            .flatMap(c => c.getProperties())
            .map(p => p.getStructure())
            .map(({ name, type }) => ({
                name,
                type,
                types: (type as string).split('|').map(s => s.trim()),
            }))) {
            if (struct.types.some(s => s.endsWith('FieldUpdateOperationsInput'))) {
                throw new Error(`Property ${struct.name} typed ${String(struct.type)}`);
            }
        }
    });

    it('scalar filter with enabled combineScalarFilters', async () => {
        await getResult({
            schema: `
            model User {
              id Int @id
              p3 String?
            }
            `,
            options: [`combineScalarFilters = true`],
        });
        expect(sourceFiles.length).toBeGreaterThan(0);
        sourceFile = sourceFiles.find(s =>
            s.getFilePath().toLowerCase().endsWith('/string-filter.input.ts'),
        )!;
        const classFile = sourceFile.getClass('StringFilter')!;
        const fieldEquals = classFile.getProperty('equals')!;
        expect(fieldEquals.getStructure().type).toEqual('string');
    });

    it('fields are not duplicated (prevent second generation)', async () => {
        await getResult({
            schema: `
            model User {
              id Int @id
            }
            `,
        });
        sourceFile = sourceFiles.find(s =>
            s.getFilePath().endsWith('int-filter.input.ts'),
        );
        const classFile = sourceFile!.getClass('IntFilter')!;
        const names = classFile.getProperties().map(p => p.getName());
        expect(names).toStrictEqual([...new Set(names)]);
    });

    it('export all from index', async () => {
        await getResult({
            schema: `
            model User {
              id        Int      @id
              posts     Post[]
            }
            model Post {
              id        Int      @id
              author    User?    @relation(fields: [authorId], references: [id])
              authorId  Int?
            }`,
        });
        await reexport(project);

        sourceFile = project.getSourceFile('/user/index.ts')!;
        expect(sourceFile.getText()).toContain(
            `export { AggregateUser } from './aggregate-user.output'`,
        );
        expect(sourceFile.getText()).toContain(`export { User } from './user.model'`);
        expect(sourceFile.getText()).toContain(
            `export { UserCreateInput } from './user-create.input'`,
        );

        sourceFile = project.getSourceFile('/post/index.ts')!;
        expect(sourceFile.getText()).toContain(
            `export { AggregatePost } from './aggregate-post.output'`,
        );
        expect(sourceFile.getText()).toContain(`export { Post } from './post.model'`);
        expect(sourceFile.getText()).toContain(
            `export { PostCreateInput } from './post-create.input'`,
        );

        sourceFile = project.getSourceFile('/index.ts')!;
        expect(sourceFile.getText()).toContain(`SortOrder } from './prisma'`);
        expect(sourceFile.getText()).toContain(
            `export { AffectedRows, FloatFilter, IntFilter, IntWithAggregatesFilter, SortOrder } from './prisma'`,
        );
        expect(sourceFile.getText()).toContain(`from './user'`);
        expect(sourceFile.getText()).toContain(`from './post'`);
    });

    describe('remove duplicate types', () => {
        const getAttributes = (sourceFile: SourceFile) =>
            sourceFile
                .getClass(x => true)
                ?.getProperties()
                .map(p => p.getStructure())
                .map(s => ({
                    name: s.name,
                    type: s.type,
                    hasQuestionToken: s.hasQuestionToken,
                    // decorator: s.decorators?.[0].name,
                }));
        const getDecorator = (sourceFile: SourceFile) =>
            sourceFile
                .getClass(() => true)
                ?.getDecorator(() => true)
                ?.getName();

        before(async () => {
            await getResult({
                schema: `
model User {
    id               String    @id @default(cuid())
    email            String    @unique
    /// User's name
    name             String    @unique
    password         String
    bio              String?
    image            String?
    following        User[]    @relation("UserFollows", references: [id])
    followers        User[]    @relation("UserFollows", references: [id])
    favoriteArticles Article[] @relation(name: "FavoritedArticles", references: [id])
    articles          Article[] @relation("ArticleAuthor")
    comments          Comment[]
    countComments    Int?
    rating           Float?
}

model Tag {
    id       String    @id @default(cuid())
    name     String    @unique
    articles Article[]
}

model Article {
    id             String    @id @default(cuid())
    slug           String    @unique
    title          String
    description    String
    body           String
    tags           Tag[]
    createdAt      DateTime  @default(now())
    updatedAt      DateTime  @updatedAt
    favoritesCount Int       @default(0)
    author         User      @relation(name: "ArticleAuthor", fields: [authorId], references: [id])
    authorId       String
    favoritedBy    User[]    @relation(name: "FavoritedArticles", references: [id])
    comments       Comment[]
    active         Boolean? @default(true)
}

model Comment {
    id        String   @id @default(cuid())
    createdAt DateTime @default(now())
    updatedAt DateTime @updatedAt
    body      String
    author    User     @relation(fields: [authorId], references: [id])
    authorId  String
    article   Article? @relation(fields: [articleId], references: [id])
    articleId String?
}
                    `,
                options: ['removeDuplicateTypes = All', 'renameZooTypes = false'],
            });
        });

        it('smoke', () => {
            const filePaths = sourceFiles.map(s => String(s.getFilePath()));
            // console.log('filePaths', filePaths);
            const unchecked = sourceFiles.find(s =>
                s.getFilePath().endsWith('user-unchecked-update.input.ts'),
            );
            unchecked?.getClass('UserUncheckedUpdateInput')?.rename('UserUpdateInput');
            const update = sourceFiles.find(s =>
                s.getFilePath().endsWith('user-update.input.ts'),
            );
            const findOne = sourceFiles.find(s =>
                s.getFilePath().endsWith('find-one-user.args.ts'),
            );
            // const isEqual = equals(unchecked?.getText(), update?.getText());
            // console.log('isEqual', isEqual);
        });

        it.only('find all duplicates', () => {
            const duplicates: any = {};
            for (const sourceFile of sourceFiles) {
                const properties = getAttributes(sourceFile);
                const decorator = getDecorator(sourceFile);
                for (const otherSourceFile of sourceFiles) {
                    if (otherSourceFile === sourceFile) {
                        continue;
                    }
                    const otherProperties = getAttributes(otherSourceFile);
                    const otherDecorator = getDecorator(otherSourceFile);
                    if (
                        properties &&
                        isEqual(properties, otherProperties) &&
                        decorator &&
                        isEqual(decorator, otherDecorator)
                    ) {
                        const key = sourceFile.getFilePath();
                        const otherSourceFiles = (duplicates[key] || []).concat(
                            otherSourceFile.getFilePath(),
                        );
                        duplicates[key] = otherSourceFiles;
                    }
                }
            }
            if (Object.entries(duplicates).length > 0) {
                log(duplicates);
            }
            expect(Object.entries(duplicates)).toHaveLength(0);
        });
    });
});
