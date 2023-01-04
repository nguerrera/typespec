import { trim } from "./charcode.js";
import { compilerAssert } from "./diagnostics.js";
import { CompilerDiagnostics, createDiagnostic } from "./messages.js";
import {
  createScanner,
  isComment,
  isKeyword,
  isPunctuation,
  isStatementKeyword,
  isTrivia,
  Token,
  TokenDisplay,
  TokenFlags,
} from "./scanner.js";
import {
  AliasStatementNode,
  AnyKeywordNode,
  AugmentDecoratorStatementNode,
  BooleanLiteralNode,
  CadlScriptNode,
  Comment,
  DeclarationNode,
  DecoratorDeclarationStatementNode,
  DecoratorExpressionNode,
  Diagnostic,
  DiagnosticReportWithoutTarget,
  DirectiveArgument,
  DirectiveExpressionNode,
  DocContent,
  DocNode,
  DocParamTagNode,
  DocReturnsTagNode,
  DocTag,
  DocTemplateTagNode,
  DocUnknownTagNode,
  EmptyStatementNode,
  EnumMemberNode,
  EnumSpreadMemberNode,
  EnumStatementNode,
  Expression,
  ExternKeywordNode,
  FunctionDeclarationStatementNode,
  FunctionParameterNode,
  IdentifierContext,
  IdentifierKind,
  IdentifierNode,
  ImportStatementNode,
  InterfaceStatementNode,
  InvalidStatementNode,
  MemberExpressionNode,
  ModelExpressionNode,
  ModelPropertyNode,
  ModelSpreadPropertyNode,
  ModelStatementNode,
  Modifier,
  ModifierFlags,
  NamespaceStatementNode,
  NeverKeywordNode,
  Node,
  NodeFlags,
  NumericLiteralNode,
  OperationSignature,
  OperationStatementNode,
  ParseOptions,
  ProjectionBlockExpressionNode,
  ProjectionEnumSelectorNode,
  ProjectionExpression,
  ProjectionExpressionStatementNode,
  ProjectionIfExpressionNode,
  ProjectionInterfaceSelectorNode,
  ProjectionLambdaExpressionNode,
  ProjectionLambdaParameterDeclarationNode,
  ProjectionModelExpressionNode,
  ProjectionModelPropertyNode,
  ProjectionModelSelectorNode,
  ProjectionModelSpreadPropertyNode,
  ProjectionNode,
  ProjectionOperationSelectorNode,
  ProjectionParameterDeclarationNode,
  ProjectionStatementItem,
  ProjectionStatementNode,
  ProjectionTupleExpressionNode,
  ProjectionUnionSelectorNode,
  ScalarStatementNode,
  SourceFile,
  Statement,
  StringLiteralNode,
  Sym,
  SyntaxKind,
  TemplateParameterDeclarationNode,
  TextRange,
  TupleExpressionNode,
  TypeReferenceNode,
  UnionStatementNode,
  UnionVariantNode,
  UsingStatementNode,
  VoidKeywordNode,
} from "./types.js";
import { isArray, mutate } from "./util.js";

/**
 * Callback to parse each element in a delimited list
 *
 * @param pos        The position of the start of the list element before any
 *                   decorators were parsed.
 *
 * @param decorators The decorators that were applied to the list element and
 *                   parsed before entering the callback.
 */
type ParseListItem<K, T> = K extends UnannotatedListKind
  ? () => T
  : (pos: number, decorators: DecoratorExpressionNode[]) => T;

type OpenToken = Token.OpenBrace | Token.OpenParen | Token.OpenBracket | Token.LessThan;
type CloseToken = Token.CloseBrace | Token.CloseParen | Token.CloseBracket | Token.GreaterThan;
type DelimiterToken = Token.Comma | Token.Semicolon;

/**
 * In order to share sensitive error recovery code, all parsing of delimited
 * lists is done using a shared driver routine parameterized by these options.
 */
interface ListKind {
  readonly allowEmpty: boolean;
  readonly open: OpenToken | Token.None;
  readonly close: CloseToken | Token.None;
  readonly delimiter: DelimiterToken;
  readonly toleratedDelimiter: DelimiterToken;
  readonly toleratedDelimiterIsValid: boolean;
  readonly trailingDelimiterIsValid: boolean;
  readonly invalidAnnotationTarget?: string;
  readonly allowedStatementKeyword: Token;
}

interface SurroundedListKind extends ListKind {
  readonly open: OpenToken;
  readonly close: CloseToken;
}

interface UnannotatedListKind extends ListKind {
  invalidAnnotationTarget: string;
}

/**
 * The fixed set of options for each of the kinds of delimited lists in Cadl.
 */
// eslint-disable-next-line @typescript-eslint/no-namespace
namespace ListKind {
  const PropertiesBase = {
    allowEmpty: true,
    toleratedDelimiterIsValid: true,
    trailingDelimiterIsValid: true,
    allowedStatementKeyword: Token.None,
  } as const;

  export const OperationParameters = {
    ...PropertiesBase,
    open: Token.OpenParen,
    close: Token.CloseParen,
    delimiter: Token.Comma,
    toleratedDelimiter: Token.Semicolon,
  } as const;

  export const DecoratorArguments = {
    ...OperationParameters,
    invalidAnnotationTarget: "expression",
  } as const;

  export const ModelProperties = {
    ...PropertiesBase,
    open: Token.OpenBrace,
    close: Token.CloseBrace,
    delimiter: Token.Semicolon,
    toleratedDelimiter: Token.Comma,
  } as const;

  export const InterfaceMembers = {
    ...PropertiesBase,
    open: Token.OpenBrace,
    close: Token.CloseBrace,
    delimiter: Token.Semicolon,
    toleratedDelimiter: Token.Comma,
    toleratedDelimiterIsValid: false,
    allowedStatementKeyword: Token.OpKeyword,
  } as const;

  export const UnionVariants = {
    ...PropertiesBase,
    open: Token.OpenBrace,
    close: Token.CloseBrace,
    delimiter: Token.Semicolon,
    toleratedDelimiter: Token.Comma,
    toleratedDelimiterIsValid: true,
  } as const;

  export const EnumMembers = {
    ...ModelProperties,
  } as const;

  const ExpresionsBase = {
    allowEmpty: true,
    delimiter: Token.Comma,
    toleratedDelimiter: Token.Semicolon,
    toleratedDelimiterIsValid: false,
    trailingDelimiterIsValid: false,
    invalidAnnotationTarget: "expression",
    allowedStatementKeyword: Token.None,
  } as const;

  export const TemplateParameters = {
    ...ExpresionsBase,
    allowEmpty: false,
    open: Token.LessThan,
    close: Token.GreaterThan,
    invalidAnnotationTarget: "template parameter",
  } as const;

  export const TemplateArguments = {
    ...TemplateParameters,
  } as const;

  export const CallArguments = {
    ...ExpresionsBase,
    allowEmpty: true,
    open: Token.OpenParen,
    close: Token.CloseParen,
  } as const;

  export const Heritage = {
    ...ExpresionsBase,
    allowEmpty: false,
    open: Token.None,
    close: Token.None,
  } as const;

  export const Tuple = {
    ...ExpresionsBase,
    allowEmpty: true,
    open: Token.OpenBracket,
    close: Token.CloseBracket,
  } as const;

  export const FunctionParameters = {
    ...ExpresionsBase,
    allowEmpty: true,
    open: Token.OpenParen,
    close: Token.CloseParen,
    invalidAnnotationTarget: "expression",
  } as const;

  export const ProjectionExpression = {
    ...ExpresionsBase,
    allowEmpty: true,
    open: Token.OpenParen,
    close: Token.CloseParen,
  } as const;

  export const ProjectionParameter = {
    ...ExpresionsBase,
    allowEmpty: true,
    open: Token.OpenParen,
    close: Token.CloseParen,
  } as const;
}

const enum ParseMode {
  Syntax,
  Doc,
}

export function parse(code: string | SourceFile, options: ParseOptions = {}): CadlScriptNode {
  const parser = createParser(code, options);
  return parser.parseCadlScript();
}

export function parseStandaloneTypeReference(
  code: string | SourceFile
): [TypeReferenceNode, readonly Diagnostic[]] {
  const parser = createParser(code);
  const node = parser.parseStandaloneReferenceExpression();
  return [node, parser.parseDiagnostics];
}

interface Parser {
  parseDiagnostics: Diagnostic[];
  parseCadlScript(): CadlScriptNode;
  parseStandaloneReferenceExpression(): TypeReferenceNode;
}

function createParser(code: string | SourceFile, options: ParseOptions = {}): Parser {
  let parseErrorInNextFinishedNode = false;
  let previousTokenEnd = -1;
  let realPositionOfLastError = -1;
  let missingIdentifierCounter = 0;
  let treePrintable = true;
  let newLineIsTrivia = true;
  let currentMode = ParseMode.Syntax;
  const parseDiagnostics: Diagnostic[] = [];
  const scanner = createScanner(code, reportDiagnostic);
  const comments: Comment[] = [];
  let docRanges: TextRange[] = [];

  nextToken();
  return {
    parseDiagnostics,
    parseCadlScript,
    parseStandaloneReferenceExpression,
  };

  function parseCadlScript(): CadlScriptNode {
    const statements = parseCadlScriptItemList();
    return {
      kind: SyntaxKind.CadlScript,
      statements,
      file: scanner.file,
      id: {
        kind: SyntaxKind.Identifier,
        sv: scanner.file.path,
        pos: 0,
        end: 0,
        flags: NodeFlags.Synthetic,
      } as any,
      namespaces: [],
      usings: [],
      locals: undefined!,
      inScopeNamespaces: [],
      parseDiagnostics,
      comments,
      printable: treePrintable,
      parseOptions: options,
      ...finishNode(0),
    };
  }

  function parseCadlScriptItemList(): Statement[] {
    const stmts: Statement[] = [];
    let seenBlocklessNs = false;
    let seenDecl = false;
    let seenUsing = false;
    while (token() !== Token.EndOfFile) {
      const [pos, docs] = parseDocList();
      const directives = parseDirectiveList();
      const decorators = parseDecoratorList();
      const tok = token();
      let item: Statement;
      switch (tok) {
        case Token.AtAt:
          reportInvalidDecorators(decorators, "augment decorator statement");
          item = parseAugmentDecorator();
          break;
        case Token.ImportKeyword:
          reportInvalidDecorators(decorators, "import statement");
          item = parseImportStatement();
          break;
        case Token.ModelKeyword:
          item = parseModelStatement(pos, decorators);
          break;
        case Token.ScalarKeyword:
          item = parseScalarStatement(pos, decorators);
          break;
        case Token.NamespaceKeyword:
          item = parseNamespaceStatement(pos, decorators);
          break;
        case Token.InterfaceKeyword:
          item = parseInterfaceStatement(pos, decorators);
          break;
        case Token.UnionKeyword:
          item = parseUnionStatement(pos, decorators);
          break;
        case Token.OpKeyword:
          item = parseOperationStatement(pos, decorators);
          break;
        case Token.EnumKeyword:
          item = parseEnumStatement(pos, decorators);
          break;
        case Token.AliasKeyword:
          reportInvalidDecorators(decorators, "alias statement");
          item = parseAliasStatement(pos);
          break;
        case Token.UsingKeyword:
          reportInvalidDecorators(decorators, "using statement");
          item = parseUsingStatement(pos);
          break;
        case Token.ProjectionKeyword:
          reportInvalidDecorators(decorators, "projection statement");
          item = parseProjectionStatement(pos);
          break;
        case Token.Semicolon:
          reportInvalidDecorators(decorators, "empty statement");
          item = parseEmptyStatement(pos);
          break;
        // Start of declaration with modifiers
        case Token.ExternKeyword:
        case Token.FnKeyword:
        case Token.DecKeyword:
          item = parseDeclaration(pos);
          break;
        default:
          item = parseInvalidStatement(pos, decorators);
          break;
      }

      mutate(item).directives = directives;
      mutate(item).docs = docs;

      if (isBlocklessNamespace(item)) {
        if (seenBlocklessNs) {
          error({ code: "multiple-blockless-namespace", target: item });
        }
        if (seenDecl) {
          error({ code: "blockless-namespace-first", target: item });
        }
        seenBlocklessNs = true;
      } else if (item.kind === SyntaxKind.ImportStatement) {
        if (seenDecl || seenBlocklessNs || seenUsing) {
          error({ code: "import-first", target: item });
        }
      } else if (item.kind === SyntaxKind.UsingStatement) {
        seenUsing = true;
      } else {
        seenDecl = true;
      }

      stmts.push(item);
    }

    return stmts;
  }

  function parseStatementList(): Statement[] {
    const stmts: Statement[] = [];

    while (token() !== Token.CloseBrace) {
      const [pos, docs] = parseDocList();
      const directives = parseDirectiveList();
      const decorators = parseDecoratorList();
      const tok = token();

      let item: Statement;
      switch (tok) {
        case Token.AtAt:
          reportInvalidDecorators(decorators, "augment decorator statement");
          item = parseAugmentDecorator();
          break;
        case Token.ImportKeyword:
          reportInvalidDecorators(decorators, "import statement");
          item = parseImportStatement();
          error({ code: "import-first", messageId: "topLevel", target: item });
          break;
        case Token.ModelKeyword:
          item = parseModelStatement(pos, decorators);
          break;
        case Token.ScalarKeyword:
          item = parseScalarStatement(pos, decorators);
          break;
        case Token.NamespaceKeyword:
          const ns = parseNamespaceStatement(pos, decorators);

          if (!Array.isArray(ns.statements)) {
            error({ code: "blockless-namespace-first", messageId: "topLevel", target: ns });
          }
          item = ns;
          break;
        case Token.InterfaceKeyword:
          item = parseInterfaceStatement(pos, decorators);
          break;
        case Token.UnionKeyword:
          item = parseUnionStatement(pos, decorators);
          break;
        case Token.OpKeyword:
          item = parseOperationStatement(pos, decorators);
          break;
        case Token.EnumKeyword:
          item = parseEnumStatement(pos, decorators);
          break;
        case Token.AliasKeyword:
          reportInvalidDecorators(decorators, "alias statement");
          item = parseAliasStatement(pos);
          break;
        case Token.UsingKeyword:
          reportInvalidDecorators(decorators, "using statement");
          item = parseUsingStatement(pos);
          break;
        case Token.ExternKeyword:
        case Token.FnKeyword:
        case Token.DecKeyword:
          item = parseDeclaration(pos);
          break;
        case Token.ProjectionKeyword:
          reportInvalidDecorators(decorators, "project statement");
          item = parseProjectionStatement(pos);
          break;
        case Token.EndOfFile:
          parseExpected(Token.CloseBrace);
          return stmts;
        case Token.Semicolon:
          reportInvalidDecorators(decorators, "empty statement");
          item = parseEmptyStatement(pos);
          break;
        default:
          item = parseInvalidStatement(pos, decorators);
          break;
      }
      mutate(item).directives = directives;
      mutate(item).docs = docs;
      stmts.push(item);
    }

    return stmts;
  }

  function parseDecoratorList() {
    const decorators: DecoratorExpressionNode[] = [];

    while (token() === Token.At) {
      decorators.push(parseDecoratorExpression());
    }

    return decorators;
  }

  function parseDirectiveList(): DirectiveExpressionNode[] {
    const directives: DirectiveExpressionNode[] = [];

    while (token() === Token.Hash) {
      directives.push(parseDirectiveExpression());
    }

    return directives;
  }

  function parseNamespaceStatement(
    pos: number,
    decorators: DecoratorExpressionNode[]
  ): NamespaceStatementNode {
    parseExpected(Token.NamespaceKeyword);
    let currentName = parseIdentifierOrMemberExpression();
    const nsSegments: IdentifierNode[] = [];
    while (currentName.kind !== SyntaxKind.Identifier) {
      nsSegments.push(currentName.id);
      currentName = currentName.base;
    }
    nsSegments.push(currentName);

    const nextTok = parseExpectedOneOf(Token.Semicolon, Token.OpenBrace);

    let statements: Statement[] | undefined;
    if (nextTok === Token.OpenBrace) {
      statements = parseStatementList();
      parseExpected(Token.CloseBrace);
    }

    let outerNs: NamespaceStatementNode = {
      kind: SyntaxKind.NamespaceStatement,
      decorators,
      id: nsSegments[0],
      locals: undefined!,
      statements,

      ...finishNode(pos),
    };

    for (let i = 1; i < nsSegments.length; i++) {
      outerNs = {
        kind: SyntaxKind.NamespaceStatement,
        decorators: [],
        id: nsSegments[i],
        statements: outerNs,
        locals: undefined!,
        ...finishNode(pos),
      };
    }

    return outerNs;
  }

  function parseInterfaceStatement(
    pos: number,
    decorators: DecoratorExpressionNode[]
  ): InterfaceStatementNode {
    parseExpected(Token.InterfaceKeyword);
    const id = parseIdentifier();
    const templateParameters = parseTemplateParameterList();

    let extendList: TypeReferenceNode[] = [];
    if (token() === Token.ExtendsKeyword) {
      nextToken();
      extendList = parseList(ListKind.Heritage, parseReferenceExpression);
    } else if (token() === Token.Identifier) {
      error({ code: "token-expected", format: { token: "'extends' or '{'" } });
      nextToken();
    }

    const operations = parseList(ListKind.InterfaceMembers, (pos, decorators) =>
      parseOperationStatement(pos, decorators, true)
    );

    return {
      kind: SyntaxKind.InterfaceStatement,
      id,
      templateParameters,
      operations,
      extends: extendList,
      decorators,
      ...finishNode(pos),
    };
  }

  function parseTemplateParameterList(): TemplateParameterDeclarationNode[] {
    const list = parseOptionalList(ListKind.TemplateParameters, parseTemplateParameter);
    let setDefault = false;
    for (const item of list) {
      if (!item.default && setDefault) {
        error({ code: "default-required", target: item });
        continue;
      }

      if (item.default) {
        setDefault = true;
      }
    }

    return list;
  }

  function parseUnionStatement(
    pos: number,
    decorators: DecoratorExpressionNode[]
  ): UnionStatementNode {
    parseExpected(Token.UnionKeyword);
    const id = parseIdentifier();
    const templateParameters = parseTemplateParameterList();

    const options = parseList(ListKind.UnionVariants, parseUnionVariant);

    return {
      kind: SyntaxKind.UnionStatement,
      id,
      templateParameters,
      decorators,
      options,
      ...finishNode(pos),
    };
  }

  function parseUnionVariant(pos: number, decorators: DecoratorExpressionNode[]): UnionVariantNode {
    const id = token() === Token.StringLiteral ? parseStringLiteral() : parseIdentifier("property");

    parseExpected(Token.Colon);

    const value = parseExpression();

    return {
      kind: SyntaxKind.UnionVariant,
      id,
      value,
      decorators,
      ...finishNode(pos),
    };
  }

  function parseUsingStatement(pos: number): UsingStatementNode {
    parseExpected(Token.UsingKeyword);
    const name = parseIdentifierOrMemberExpression(undefined, true);
    parseExpected(Token.Semicolon);

    return {
      kind: SyntaxKind.UsingStatement,
      name,
      ...finishNode(pos),
    };
  }

  function parseOperationStatement(
    pos: number,
    decorators: DecoratorExpressionNode[],
    inInterface?: boolean
  ): OperationStatementNode {
    if (inInterface) {
      parseOptional(Token.OpKeyword);
    } else {
      parseExpected(Token.OpKeyword);
    }

    const id = parseIdentifier();
    const templateParameters = inInterface ? [] : parseTemplateParameterList();

    // Make sure the next token is one that is expected
    const token = expectTokenIsOneOf(Token.OpenParen, Token.IsKeyword);

    // Check if we're parsing a declaration or reuse of another operation
    let signature: OperationSignature;
    const signaturePos = tokenPos();
    if (token === Token.OpenParen) {
      const parameters = parseOperationParameters();
      parseExpected(Token.Colon);
      const returnType = parseExpression();

      signature = {
        kind: SyntaxKind.OperationSignatureDeclaration,
        parameters,
        returnType,
        ...finishNode(signaturePos),
      };
    } else {
      parseExpected(Token.IsKeyword);
      const opReference = parseReferenceExpression();

      signature = {
        kind: SyntaxKind.OperationSignatureReference,
        baseOperation: opReference,
        ...finishNode(signaturePos),
      };
    }

    // The interface parser handles semicolon parsing between statements
    if (!inInterface) {
      parseExpected(Token.Semicolon);
    }

    return {
      kind: SyntaxKind.OperationStatement,
      id,
      templateParameters,
      signature,
      decorators,
      ...finishNode(pos),
    };
  }

  function parseOperationParameters(): ModelExpressionNode {
    const pos = tokenPos();
    const properties = parseList(ListKind.OperationParameters, parseModelPropertyOrSpread);
    const parameters: ModelExpressionNode = {
      kind: SyntaxKind.ModelExpression,
      properties,
      ...finishNode(pos),
    };
    return parameters;
  }

  function parseModelStatement(
    pos: number,
    decorators: DecoratorExpressionNode[]
  ): ModelStatementNode {
    parseExpected(Token.ModelKeyword);
    const id = parseIdentifier();
    const templateParameters = parseTemplateParameterList();

    expectTokenIsOneOf(Token.OpenBrace, Token.Equals, Token.ExtendsKeyword, Token.IsKeyword);

    const optionalExtends = parseOptionalModelExtends();
    const optionalIs = optionalExtends ? undefined : parseOptionalModelIs();

    let properties: (ModelPropertyNode | ModelSpreadPropertyNode)[] = [];
    if (optionalIs) {
      const tok = expectTokenIsOneOf(Token.Semicolon, Token.OpenBrace);
      if (tok === Token.Semicolon) {
        nextToken();
      } else {
        properties = parseList(ListKind.ModelProperties, parseModelPropertyOrSpread);
      }
    } else {
      properties = parseList(ListKind.ModelProperties, parseModelPropertyOrSpread);
    }

    return {
      kind: SyntaxKind.ModelStatement,
      id,
      extends: optionalExtends,
      is: optionalIs,
      templateParameters,
      decorators,
      properties,
      ...finishNode(pos),
    };
  }

  function parseOptionalModelExtends() {
    if (parseOptional(Token.ExtendsKeyword)) {
      return parseExpression();
    }
    return undefined;
  }

  function parseOptionalModelIs() {
    if (parseOptional(Token.IsKeyword)) {
      return parseExpression();
    }
    return;
  }

  function parseTemplateParameter(): TemplateParameterDeclarationNode {
    const pos = tokenPos();
    const id = parseIdentifier();
    let constraint: Expression | undefined;
    if (parseOptional(Token.ExtendsKeyword)) {
      constraint = parseExpression();
    }
    let def: Expression | undefined;
    if (parseOptional(Token.Equals)) {
      def = parseExpression();
    }
    return {
      kind: SyntaxKind.TemplateParameterDeclaration,
      id,
      constraint,
      default: def,
      ...finishNode(pos),
    };
  }

  function parseModelPropertyOrSpread(pos: number, decorators: DecoratorExpressionNode[]) {
    return token() === Token.Ellipsis
      ? parseModelSpreadProperty(pos, decorators)
      : parseModelProperty(pos, decorators);
  }

  function parseModelSpreadProperty(
    pos: number,
    decorators: DecoratorExpressionNode[]
  ): ModelSpreadPropertyNode {
    parseExpected(Token.Ellipsis);

    reportInvalidDecorators(decorators, "spread property");

    // This could be broadened to allow any type expression
    const target = parseReferenceExpression();

    return {
      kind: SyntaxKind.ModelSpreadProperty,
      target,
      ...finishNode(pos),
    };
  }

  function parseModelProperty(
    pos: number,
    decorators: DecoratorExpressionNode[]
  ): ModelPropertyNode {
    const id = token() === Token.StringLiteral ? parseStringLiteral() : parseIdentifier("property");

    const optional = parseOptional(Token.Question);
    parseExpected(Token.Colon);
    const value = parseExpression();

    const hasDefault = parseOptional(Token.Equals);
    if (hasDefault && !optional) {
      error({ code: "default-optional" });
    }
    const defaultValue = hasDefault ? parseExpression() : undefined;
    return {
      kind: SyntaxKind.ModelProperty,
      id,
      decorators,
      value,
      optional,
      default: defaultValue,
      ...finishNode(pos),
    };
  }

  function parseScalarStatement(
    pos: number,
    decorators: DecoratorExpressionNode[]
  ): ScalarStatementNode {
    parseExpected(Token.ScalarKeyword);
    const id = parseIdentifier();
    const templateParameters = parseTemplateParameterList();

    const optionalExtends = parseOptionalScalarExtends();

    return {
      kind: SyntaxKind.ScalarStatement,
      id,
      templateParameters,
      extends: optionalExtends,
      decorators,
      ...finishNode(pos),
    };
  }

  function parseOptionalScalarExtends() {
    if (parseOptional(Token.ExtendsKeyword)) {
      return parseReferenceExpression();
    }
    return undefined;
  }

  function parseEnumStatement(
    pos: number,
    decorators: DecoratorExpressionNode[]
  ): EnumStatementNode {
    parseExpected(Token.EnumKeyword);
    const id = parseIdentifier();
    const members = parseList(ListKind.EnumMembers, parseEnumMemberOrSpread);
    return {
      kind: SyntaxKind.EnumStatement,
      id,
      decorators,
      members,
      ...finishNode(pos),
    };
  }

  function parseEnumMemberOrSpread(pos: number, decorators: DecoratorExpressionNode[]) {
    return token() === Token.Ellipsis
      ? parseEnumSpreadMember(pos, decorators)
      : parseEnumMember(pos, decorators);
  }

  function parseEnumSpreadMember(
    pos: number,
    decorators: DecoratorExpressionNode[]
  ): EnumSpreadMemberNode {
    parseExpected(Token.Ellipsis);

    reportInvalidDecorators(decorators, "spread enum");

    const target = parseReferenceExpression();

    return {
      kind: SyntaxKind.EnumSpreadMember,
      target,
      ...finishNode(pos),
    };
  }

  function parseEnumMember(pos: number, decorators: DecoratorExpressionNode[]): EnumMemberNode {
    const id =
      token() === Token.StringLiteral ? parseStringLiteral() : parseIdentifier("enumMember");

    let value: StringLiteralNode | NumericLiteralNode | undefined;
    if (parseOptional(Token.Colon)) {
      const expr = parseExpression();

      if (expr.kind === SyntaxKind.StringLiteral || expr.kind === SyntaxKind.NumericLiteral) {
        value = expr;
      } else if (
        expr.kind === SyntaxKind.TypeReference &&
        expr.target.flags & NodeFlags.ThisNodeHasError
      ) {
        parseErrorInNextFinishedNode = true;
      } else {
        error({ code: "token-expected", messageId: "numericOrStringLiteral", target: expr });
      }
    }

    return {
      kind: SyntaxKind.EnumMember,
      id,
      value,
      decorators,
      ...finishNode(pos),
    };
  }

  function parseAliasStatement(pos: number): AliasStatementNode {
    parseExpected(Token.AliasKeyword);
    const id = parseIdentifier();
    const templateParameters = parseTemplateParameterList();
    parseExpected(Token.Equals);
    const value = parseExpression();
    parseExpected(Token.Semicolon);
    return {
      kind: SyntaxKind.AliasStatement,
      id,
      templateParameters,
      value,
      ...finishNode(pos),
    };
  }

  function parseExpression(): Expression {
    return parseUnionExpressionOrHigher();
  }

  function parseUnionExpressionOrHigher(): Expression {
    const pos = tokenPos();
    parseOptional(Token.Bar);
    const node: Expression = parseIntersectionExpressionOrHigher();

    if (token() !== Token.Bar) {
      return node;
    }

    const options = [node];
    while (parseOptional(Token.Bar)) {
      const expr = parseIntersectionExpressionOrHigher();
      options.push(expr);
    }

    return {
      kind: SyntaxKind.UnionExpression,
      options,
      ...finishNode(pos),
    };
  }

  function parseIntersectionExpressionOrHigher(): Expression {
    const pos = tokenPos();
    parseOptional(Token.Ampersand);
    const node: Expression = parseArrayExpressionOrHigher();

    if (token() !== Token.Ampersand) {
      return node;
    }

    const options = [node];
    while (parseOptional(Token.Ampersand)) {
      const expr = parseArrayExpressionOrHigher();
      options.push(expr);
    }

    return {
      kind: SyntaxKind.IntersectionExpression,
      options,
      ...finishNode(pos),
    };
  }

  function parseArrayExpressionOrHigher(): Expression {
    const pos = tokenPos();
    let expr = parsePrimaryExpression();

    while (parseOptional(Token.OpenBracket)) {
      parseExpected(Token.CloseBracket);

      expr = {
        kind: SyntaxKind.ArrayExpression,
        elementType: expr,
        ...finishNode(pos),
      };
    }

    return expr;
  }

  function parseStandaloneReferenceExpression() {
    const expr = parseReferenceExpression();
    if (parseDiagnostics.length === 0 && token() !== Token.EndOfFile) {
      error({ code: "token-expected", messageId: "unexpected", format: { token: Token[token()] } });
    }
    return expr;
  }
  function parseReferenceExpression(
    message?: keyof CompilerDiagnostics["token-expected"]
  ): TypeReferenceNode {
    const pos = tokenPos();
    const target = parseIdentifierOrMemberExpression(message);
    const args = parseOptionalList(ListKind.TemplateArguments, parseExpression);

    return {
      kind: SyntaxKind.TypeReference,
      target,
      arguments: args,
      ...finishNode(pos),
    };
  }

  function parseAugmentDecorator(): AugmentDecoratorStatementNode {
    const pos = tokenPos();
    parseExpected(Token.AtAt);

    // Error recovery: false arg here means don't treat a keyword as an
    // identifier. We want to parse `@ model Foo` as invalid decorator
    // `@<missing identifier>` applied to `model Foo`, and not as `@model`
    // applied to invalid statement `Foo`.
    const target = parseIdentifierOrMemberExpression(undefined, false);
    const args = parseOptionalList(ListKind.DecoratorArguments, parseExpression);
    if (args.length === 0) {
      error({ code: "augment-decorator-target" });
      return {
        kind: SyntaxKind.AugmentDecoratorStatement,
        target,
        targetType: {
          kind: SyntaxKind.TypeReference,
          target: createMissingIdentifier(),
          arguments: [],
          ...finishNode(pos),
        },
        arguments: [],
        ...finishNode(pos),
      };
    }
    let [targetEntity, ...decoratorArgs] = args;
    if (targetEntity.kind !== SyntaxKind.TypeReference) {
      error({ code: "augment-decorator-target", target: targetEntity });
      targetEntity = {
        kind: SyntaxKind.TypeReference,
        target: createMissingIdentifier(),
        arguments: [],
        ...finishNode(pos),
      };
    }
    return {
      kind: SyntaxKind.AugmentDecoratorStatement,
      target,
      targetType: targetEntity,
      arguments: decoratorArgs,
      ...finishNode(pos),
    };
  }
  function parseImportStatement(): ImportStatementNode {
    const pos = tokenPos();

    parseExpected(Token.ImportKeyword);
    const path = parseStringLiteral();

    parseExpected(Token.Semicolon);
    return {
      kind: SyntaxKind.ImportStatement,
      path,
      ...finishNode(pos),
    };
  }

  function parseDecoratorExpression(): DecoratorExpressionNode {
    const pos = tokenPos();
    parseExpected(Token.At);

    // Error recovery: false arg here means don't treat a keyword as an
    // identifier. We want to parse `@ model Foo` as invalid decorator
    // `@<missing identifier>` applied to `model Foo`, and not as `@model`
    // applied to invalid statement `Foo`.
    const target = parseIdentifierOrMemberExpression(undefined, false);
    const args = parseOptionalList(ListKind.DecoratorArguments, parseExpression);
    return {
      kind: SyntaxKind.DecoratorExpression,
      arguments: args,
      target,
      ...finishNode(pos),
    };
  }

  function parseDirectiveExpression(): DirectiveExpressionNode {
    const pos = tokenPos();
    parseExpected(Token.Hash);

    const target = parseIdentifier();
    if (target.sv !== "suppress") {
      error({
        code: "unknown-directive",
        format: { id: target.sv },
        target: { pos, end: pos + target.sv.length },
        printable: true,
      });
    }
    // The newline will mark the end of the directive.
    newLineIsTrivia = false;
    const args = [];
    while (token() !== Token.NewLine && token() !== Token.EndOfFile) {
      const param = parseDirectiveParameter();
      if (param) {
        args.push(param);
      }
    }

    newLineIsTrivia = true;
    nextToken();
    return {
      kind: SyntaxKind.DirectiveExpression,
      arguments: args,
      target,
      ...finishNode(pos),
    };
  }

  function parseDirectiveParameter(): DirectiveArgument | undefined {
    switch (token()) {
      case Token.Identifier:
        return parseIdentifier();
      case Token.StringLiteral:
        return parseStringLiteral();
      default:
        error({
          code: "token-expected",
          messageId: "unexpected",
          format: { token: Token[token()] },
        });
        do {
          nextToken();
        } while (
          !isStatementKeyword(token()) &&
          token() !== Token.NewLine &&
          token() !== Token.At &&
          token() !== Token.Semicolon &&
          token() !== Token.EndOfFile
        );
        return undefined;
    }
  }

  function parseIdentifierOrMemberExpression(
    message?: keyof CompilerDiagnostics["token-expected"],
    recoverFromKeyword = true
  ): IdentifierNode | MemberExpressionNode {
    const pos = tokenPos();
    let base: IdentifierNode | MemberExpressionNode = parseIdentifier(message, recoverFromKeyword);
    while (parseOptional(Token.Dot)) {
      base = {
        kind: SyntaxKind.MemberExpression,
        base,
        // Error recovery: false arg here means don't treat a keyword as an
        // identifier after `.` in member expression. Otherwise we will
        // parse `@Outer.<missing identifier> model M{}` as having decorator
        // `@Outer.model` applied to invalid statement `M {}` instead of
        // having incomplete decorator `@Outer.` applied to `model M {}`.
        id: parseIdentifier(undefined, false),
        ...finishNode(pos),
      };
    }

    return base;
  }

  function parsePrimaryExpression(): Expression {
    while (true) {
      switch (token()) {
        case Token.Identifier:
          return parseReferenceExpression();
        case Token.StringLiteral:
          return parseStringLiteral();
        case Token.TrueKeyword:
        case Token.FalseKeyword:
          return parseBooleanLiteral();
        case Token.NumericLiteral:
          return parseNumericLiteral();
        case Token.OpenBrace:
          return parseModelExpression();
        case Token.OpenBracket:
          return parseTupleExpression();
        case Token.OpenParen:
          return parseParenthesizedExpression();
        case Token.At:
          const decorators = parseDecoratorList();
          reportInvalidDecorators(decorators, "expression");
          continue;
        case Token.Hash:
          const directives = parseDirectiveList();
          reportInvalidDirective(directives, "expression");
          continue;
        case Token.VoidKeyword:
          return parseVoidKeyword();
        case Token.NeverKeyword:
          return parseNeverKeyword();
        case Token.UnknownKeyword:
          return parseUnknownKeyword();
        default:
          return parseReferenceExpression("expression");
      }
    }
  }

  function parseExternKeyword(): ExternKeywordNode {
    const pos = tokenPos();
    parseExpected(Token.ExternKeyword);
    return {
      kind: SyntaxKind.ExternKeyword,
      ...finishNode(pos),
    };
  }

  function parseVoidKeyword(): VoidKeywordNode {
    const pos = tokenPos();
    parseExpected(Token.VoidKeyword);
    return {
      kind: SyntaxKind.VoidKeyword,
      ...finishNode(pos),
    };
  }

  function parseNeverKeyword(): NeverKeywordNode {
    const pos = tokenPos();
    parseExpected(Token.NeverKeyword);
    return {
      kind: SyntaxKind.NeverKeyword,
      ...finishNode(pos),
    };
  }

  function parseUnknownKeyword(): AnyKeywordNode {
    const pos = tokenPos();
    parseExpected(Token.UnknownKeyword);
    return {
      kind: SyntaxKind.UnknownKeyword,
      ...finishNode(pos),
    };
  }

  function parseParenthesizedExpression(): Expression {
    const pos = tokenPos();
    parseExpected(Token.OpenParen);
    const expr = parseExpression();
    parseExpected(Token.CloseParen);
    return { ...expr, ...finishNode(pos) };
  }

  function parseTupleExpression(): TupleExpressionNode {
    const pos = tokenPos();
    const values = parseList(ListKind.Tuple, parseExpression);
    return {
      kind: SyntaxKind.TupleExpression,
      values,
      ...finishNode(pos),
    };
  }

  function parseModelExpression(): ModelExpressionNode {
    const pos = tokenPos();
    const properties = parseList(ListKind.ModelProperties, parseModelPropertyOrSpread);
    return {
      kind: SyntaxKind.ModelExpression,
      properties,
      ...finishNode(pos),
    };
  }

  function parseStringLiteral(): StringLiteralNode {
    const pos = tokenPos();
    const value = tokenValue();
    parseExpected(Token.StringLiteral);
    return {
      kind: SyntaxKind.StringLiteral,
      value,
      ...finishNode(pos),
    };
  }

  function parseNumericLiteral(): NumericLiteralNode {
    const pos = tokenPos();
    const text = tokenValue();
    const value = Number(text);

    parseExpected(Token.NumericLiteral);
    return {
      kind: SyntaxKind.NumericLiteral,
      value,
      ...finishNode(pos),
    };
  }

  function parseBooleanLiteral(): BooleanLiteralNode {
    const pos = tokenPos();
    const token = parseExpectedOneOf(Token.TrueKeyword, Token.FalseKeyword);
    const value = token === Token.TrueKeyword;
    return {
      kind: SyntaxKind.BooleanLiteral,
      value,
      ...finishNode(pos),
    };
  }

  function parseIdentifier(
    message?: keyof CompilerDiagnostics["token-expected"],
    recoverFromKeyword = true
  ): IdentifierNode {
    if (recoverFromKeyword && isKeyword(token())) {
      error({ code: "reserved-identifier" });
    } else if (token() !== Token.Identifier) {
      // Error recovery: when we fail to parse an identifier or expression,
      // we insert a synthesized identifier with a unique name.
      error({ code: "token-expected", messageId: message ?? "identifier" });
      return createMissingIdentifier();
    }

    const pos = tokenPos();
    const sv = tokenValue();
    nextToken();

    return {
      kind: SyntaxKind.Identifier,
      sv,
      ...finishNode(pos),
    };
  }

  function parseDeclaration(
    pos: number
  ): DecoratorDeclarationStatementNode | FunctionDeclarationStatementNode | InvalidStatementNode {
    const modifiers = parseModifiers();
    switch (token()) {
      case Token.DecKeyword:
        return parseDecoratorDeclarationStatement(pos, modifiers);
      case Token.FnKeyword:
        return parseFunctionDeclarationStatement(pos, modifiers);
    }
    return parseInvalidStatement(pos, []);
  }

  function parseModifiers(): Modifier[] {
    const modifiers: Modifier[] = [];
    let modifier;
    while ((modifier = parseModifier())) {
      modifiers.push(modifier);
    }
    return modifiers;
  }

  function parseModifier(): Modifier | undefined {
    switch (token()) {
      case Token.ExternKeyword:
        return parseExternKeyword();
      default:
        return undefined;
    }
  }

  function parseDecoratorDeclarationStatement(
    pos: number,
    modifiers: Modifier[]
  ): DecoratorDeclarationStatementNode {
    const modifierFlags = modifiersToFlags(modifiers);
    parseExpected(Token.DecKeyword);
    const id = parseIdentifier();
    let [target, ...parameters] = parseFunctionParameters();
    if (target === undefined) {
      error({ code: "decorator-decl-target", target: { pos, end: previousTokenEnd } });
      target = {
        kind: SyntaxKind.FunctionParameter,
        id: createMissingIdentifier(),
        type: createMissingIdentifier(),
        optional: false,
        rest: false,
        ...finishNode(pos),
      };
    }
    if (target.optional) {
      error({ code: "decorator-decl-target", messageId: "required" });
    }
    parseExpected(Token.Semicolon);
    return {
      kind: SyntaxKind.DecoratorDeclarationStatement,
      modifiers,
      modifierFlags,
      id,
      target,
      parameters,
      ...finishNode(pos),
    };
  }

  function parseFunctionDeclarationStatement(
    pos: number,
    modifiers: Modifier[]
  ): FunctionDeclarationStatementNode {
    const modifierFlags = modifiersToFlags(modifiers);
    parseExpected(Token.FnKeyword);
    const id = parseIdentifier();
    const parameters = parseFunctionParameters();
    let returnType;
    if (parseOptional(Token.Colon)) {
      returnType = parseExpression();
    }
    parseExpected(Token.Semicolon);
    return {
      kind: SyntaxKind.FunctionDeclarationStatement,
      modifiers,
      modifierFlags,
      id,
      parameters,
      returnType,
      ...finishNode(pos),
    };
  }

  function parseFunctionParameters(): FunctionParameterNode[] {
    const parameters = parseList<typeof ListKind.FunctionParameters, FunctionParameterNode>(
      ListKind.FunctionParameters,
      parseFunctionParameter
    );

    let foundOptional = false;
    for (const [index, item] of parameters.entries()) {
      if (!item.optional && foundOptional) {
        error({ code: "required-parameter-first", target: item });
        continue;
      }

      if (item.optional) {
        foundOptional = true;
      }

      if (item.rest && item.optional) {
        error({ code: "rest-parameter-required", target: item });
      }
      if (item.rest && index !== parameters.length - 1) {
        error({ code: "rest-parameter-last", target: item });
      }
    }
    return parameters;
  }

  function parseFunctionParameter(): FunctionParameterNode {
    const pos = tokenPos();
    const rest = parseOptional(Token.Ellipsis);
    const id = parseIdentifier("property");

    const optional = parseOptional(Token.Question);
    let type;
    if (parseOptional(Token.Colon)) {
      type = parseExpression();
    }
    return {
      kind: SyntaxKind.FunctionParameter,
      id,
      type,
      optional,
      rest,
      ...finishNode(pos),
    };
  }

  function modifiersToFlags(modifiers: Modifier[]): ModifierFlags {
    let flags = ModifierFlags.None;
    for (const modifier of modifiers) {
      switch (modifier.kind) {
        case SyntaxKind.ExternKeyword:
          flags |= ModifierFlags.Extern;
          break;
      }
    }
    return flags;
  }

  function parseProjectionStatement(pos: number): ProjectionStatementNode {
    parseExpected(Token.ProjectionKeyword);
    const selector = parseProjectionSelector();
    parseExpected(Token.Hash);

    const id = parseIdentifier();

    parseExpected(Token.OpenBrace);
    let from, to;
    let proj1, proj2;
    if (token() === Token.Identifier) {
      proj1 = parseProjection();

      if (token() === Token.Identifier) {
        proj2 = parseProjection();
      }
    }

    if (proj1 && proj2 && proj1.direction === proj2.direction) {
      error({ code: "duplicate-symbol", target: proj2, format: { name: "projection" } });
    } else if (proj1) {
      [to, from] = proj1.direction === "to" ? [proj1, proj2] : [proj2, proj1];
    }

    parseExpected(Token.CloseBrace);

    return {
      kind: SyntaxKind.ProjectionStatement,
      selector,
      from,
      to,
      id,
      ...finishNode(pos),
    };
  }

  function parseProjection(): ProjectionNode {
    const pos = tokenPos();
    const directionId = parseIdentifier("projectionDirection");
    let direction: "to" | "from";
    if (directionId.sv !== "from" && directionId.sv !== "to") {
      error({ code: "token-expected", messageId: "projectionDirection" });
      direction = "from";
    } else {
      direction = directionId.sv;
    }
    let parameters: ProjectionParameterDeclarationNode[];
    if (token() === Token.OpenParen) {
      parameters = parseList(ListKind.ProjectionParameter, parseProjectionParameter);
    } else {
      parameters = [];
    }
    parseExpected(Token.OpenBrace);
    const body: ProjectionStatementItem[] = parseProjectionStatementList();
    parseExpected(Token.CloseBrace);

    return {
      kind: SyntaxKind.Projection,
      body,
      direction,
      directionId,
      parameters,
      ...finishNode(pos),
    };
  }

  function parseProjectionParameter(): ProjectionParameterDeclarationNode {
    const pos = tokenPos();
    const id = parseIdentifier();
    return {
      kind: SyntaxKind.ProjectionParameterDeclaration,
      id,
      ...finishNode(pos),
    };
  }
  function parseProjectionStatementList(): ProjectionStatementItem[] {
    const stmts = [];

    while (token() !== Token.CloseBrace) {
      const startPos = tokenPos();
      if (token() === Token.EndOfFile) {
        error({ code: "token-expected", messageId: "default", format: { token: "}" } });
        break;
      }

      const expr = parseProjectionExpressionStatement();
      stmts.push(expr);

      if (tokenPos() === startPos) {
        // we didn't manage to parse anything, so break out
        // and we'll report errors elsewhere.
        break;
      }
    }

    return stmts;
  }

  function parseProjectionExpressionStatement(): ProjectionExpressionStatementNode {
    const pos = tokenPos();
    const expr = parseProjectionExpression();
    parseExpected(Token.Semicolon);
    return {
      kind: SyntaxKind.ProjectionExpressionStatement,
      expr,
      ...finishNode(pos),
    };
  }

  function parseProjectionExpression() {
    return parseProjectionReturnExpressionOrHigher();
  }

  function parseProjectionReturnExpressionOrHigher(): ProjectionExpression {
    if (token() === Token.ReturnKeyword) {
      const pos = tokenPos();
      parseExpected(Token.ReturnKeyword);
      return {
        kind: SyntaxKind.Return,
        value: parseProjectionExpression(),
        ...finishNode(pos),
      };
    }

    return parseProjectionLogicalOrExpressionOrHigher();
  }

  function parseProjectionLogicalOrExpressionOrHigher(): ProjectionExpression {
    let expr = parseProjectionLogicalAndExpressionOrHigher();
    while (token() !== Token.EndOfFile) {
      const pos = expr.pos;
      if (parseOptional(Token.BarBar)) {
        expr = {
          kind: SyntaxKind.ProjectionLogicalExpression,
          op: "||",
          left: expr,
          right: parseProjectionLogicalAndExpressionOrHigher(),
          ...finishNode(pos),
        };
      } else {
        break;
      }
    }

    return expr;
  }

  function parseProjectionLogicalAndExpressionOrHigher(): ProjectionExpression {
    let expr: ProjectionExpression = parseProjectionEqualityExpressionOrHigher();

    while (token() !== Token.EndOfFile) {
      const pos = expr.pos;
      if (parseOptional(Token.AmpsersandAmpersand)) {
        expr = {
          kind: SyntaxKind.ProjectionLogicalExpression,
          op: "&&",
          left: expr,
          right: parseIdentifier(),
          ...finishNode(pos),
        };
      } else {
        break;
      }
    }

    return expr;
  }

  function parseProjectionEqualityExpressionOrHigher(): ProjectionExpression {
    let expr: ProjectionExpression = parseProjectionRelationalExpressionOrHigher();
    while (token() !== Token.EndOfFile) {
      const pos = expr.pos;
      const tok = token();
      if (tok === Token.EqualsEquals || tok === Token.ExclamationEquals) {
        const op = tokenValue() as "==" | "!=";
        nextToken();
        expr = {
          kind: SyntaxKind.ProjectionEqualityExpression,
          op,
          left: expr,
          right: parseProjectionRelationalExpressionOrHigher(),
          ...finishNode(pos),
        };
      } else {
        break;
      }
    }

    return expr;
  }

  function parseProjectionRelationalExpressionOrHigher(): ProjectionExpression {
    let expr: ProjectionExpression = parseProjectionAdditiveExpressionOrHigher();

    while (token() !== Token.EndOfFile) {
      const pos: number = expr.pos;
      const tok = token();
      if (
        tok === Token.LessThan ||
        tok === Token.LessThanEquals ||
        tok === Token.GreaterThan ||
        tok === Token.GreaterThanEquals
      ) {
        const op = tokenValue() as "<" | "<=" | ">" | ">=";
        nextToken();
        expr = {
          kind: SyntaxKind.ProjectionRelationalExpression,
          op,
          left: expr,
          right: parseProjectionAdditiveExpressionOrHigher(),
          ...finishNode(pos),
        };
      } else {
        break;
      }
    }

    return expr;
  }

  function parseProjectionAdditiveExpressionOrHigher(): ProjectionExpression {
    let expr: ProjectionExpression = parseProjectionMultiplicativeExpressionOrHigher();
    while (token() !== Token.EndOfFile) {
      const pos: number = expr.pos;
      const tok = token();
      if (tok === Token.Plus || tok === Token.Hyphen) {
        const op = tokenValue() as "+" | "-";
        nextToken();
        expr = {
          kind: SyntaxKind.ProjectionArithmeticExpression,
          op,
          left: expr,
          right: parseProjectionMultiplicativeExpressionOrHigher(),
          ...finishNode(pos),
        };
      } else {
        break;
      }
    }

    return expr;
  }

  function parseProjectionMultiplicativeExpressionOrHigher(): ProjectionExpression {
    let expr: ProjectionExpression = parseProjectionUnaryExpressionOrHigher();
    while (token() !== Token.EndOfFile) {
      const pos: number = expr.pos;
      const tok = token();
      if (tok === Token.ForwardSlash || tok === Token.Star) {
        const op = tokenValue() as "/" | "*";
        nextToken();
        expr = {
          kind: SyntaxKind.ProjectionArithmeticExpression,
          op,
          left: expr,
          right: parseProjectionUnaryExpressionOrHigher(),
          ...finishNode(pos),
        };
      } else {
        break;
      }
    }

    return expr;
  }

  function parseProjectionUnaryExpressionOrHigher(): ProjectionExpression {
    if (token() === Token.Exclamation) {
      const pos = tokenPos();
      nextToken();
      return {
        kind: SyntaxKind.ProjectionUnaryExpression,
        op: "!",
        target: parseProjectionUnaryExpressionOrHigher(),
        ...finishNode(pos),
      };
    }
    return parseProjectionCallExpressionOrHigher();
  }

  function parseProjectionCallExpressionOrHigher(): ProjectionExpression {
    let expr: ProjectionExpression = parseProjectionDecoratorReferenceExpressionOrHigher();

    while (token() !== Token.EndOfFile) {
      const pos: number = expr.pos;
      expr = parseProjectionMemberExpressionRest(expr, pos);
      if (token() === Token.OpenParen) {
        expr = {
          kind: SyntaxKind.ProjectionCallExpression,
          callKind: "method",
          target: expr,
          arguments: parseList(ListKind.CallArguments, parseProjectionExpression),
          ...finishNode(pos),
        };
      } else {
        break;
      }
    }

    return expr;
  }

  function parseProjectionDecoratorReferenceExpressionOrHigher(): ProjectionExpression {
    if (token() === Token.At) {
      const pos = tokenPos();
      nextToken();
      return {
        kind: SyntaxKind.ProjectionDecoratorReferenceExpression,
        target: parseIdentifierOrMemberExpression(undefined, true),
        ...finishNode(pos),
      };
    }

    return parseProjectionMemberExpressionOrHigher();
  }

  function parseProjectionMemberExpressionOrHigher(): ProjectionExpression {
    const pos = tokenPos();
    let expr = parseProjectionPrimaryExpression();
    expr = parseProjectionMemberExpressionRest(expr, pos);
    return expr;
  }

  function parseProjectionMemberExpressionRest(
    expr: ProjectionExpression,
    pos: number
  ): ProjectionExpression {
    while (token() !== Token.EndOfFile) {
      if (parseOptional(Token.Dot)) {
        expr = {
          kind: SyntaxKind.ProjectionMemberExpression,
          base: expr,
          id: parseIdentifier(),
          selector: ".",
          ...finishNode(pos),
        };
      } else if (parseOptional(Token.ColonColon)) {
        expr = {
          kind: SyntaxKind.ProjectionMemberExpression,
          base: expr,
          id: parseIdentifier(),
          selector: "::",
          ...finishNode(pos),
        };
      } else {
        break;
      }
    }

    return expr;
  }

  function parseProjectionPrimaryExpression(): ProjectionExpression {
    switch (token()) {
      case Token.IfKeyword:
        return parseProjectionIfExpression();
      case Token.NumericLiteral:
        return parseNumericLiteral();
      case Token.StringLiteral:
        return parseStringLiteral();
      case Token.TrueKeyword:
      case Token.FalseKeyword:
        return parseBooleanLiteral();
      case Token.OpenBracket:
        return parseProjectionTupleExpression();
      case Token.OpenBrace:
        return parseProjectionModelExpression();
      case Token.OpenParen:
        return parseProjectionLambdaOrParenthesizedExpression();
      case Token.VoidKeyword:
        return parseVoidKeyword();
      case Token.NeverKeyword:
        return parseNeverKeyword();
      case Token.UnknownKeyword:
        return parseUnknownKeyword();
      default:
        return parseIdentifier("expression");
    }
  }

  function parseProjectionLambdaOrParenthesizedExpression(): ProjectionExpression {
    const pos = tokenPos();
    const exprs = parseList(ListKind.ProjectionExpression, parseProjectionExpression);
    if (token() === Token.EqualsGreaterThan) {
      // unpack the exprs (which should be just identifiers) into a param list
      const params: ProjectionLambdaParameterDeclarationNode[] = [];
      for (const expr of exprs) {
        if (expr.kind === SyntaxKind.Identifier) {
          params.push(
            withSymbol({
              kind: SyntaxKind.ProjectionLambdaParameterDeclaration,
              id: expr,
              pos: expr.pos,
              end: expr.end,
              flags: NodeFlags.None,
            })
          );
        } else {
          error({ code: "token-expected", messageId: "identifier", target: expr });
        }
      }

      return parseProjectionLambdaExpressionRest(pos, params);
    } else {
      if (exprs.length === 0) {
        error({
          code: "token-expected",
          messageId: "expression",
        });
      }
      // verify we only have one entry
      for (let i = 1; i < exprs.length; i++) {
        error({
          code: "token-expected",
          messageId: "unexpected",
          format: { token: "expression" },
          target: exprs[i],
        });
      }

      return exprs[0];
    }
  }

  function parseProjectionLambdaExpressionRest(
    pos: number,
    parameters: ProjectionLambdaParameterDeclarationNode[]
  ): ProjectionLambdaExpressionNode {
    parseExpected(Token.EqualsGreaterThan);
    const body = parseProjectionBlockExpression();
    return {
      kind: SyntaxKind.ProjectionLambdaExpression,
      parameters,
      body,
      ...finishNode(pos),
    };
  }

  function parseProjectionModelExpression(): ProjectionModelExpressionNode {
    const pos = tokenPos();
    const properties = parseList(ListKind.ModelProperties, parseProjectionModelPropertyOrSpread);
    return {
      kind: SyntaxKind.ProjectionModelExpression,
      properties,
      ...finishNode(pos),
    };
  }

  function parseProjectionModelPropertyOrSpread(
    pos: number,
    decorators: DecoratorExpressionNode[]
  ) {
    return token() === Token.Ellipsis
      ? parseProjectionModelSpreadProperty(pos, decorators)
      : parseProjectionModelProperty(pos, decorators);
  }

  function parseProjectionModelSpreadProperty(
    pos: number,
    decorators: DecoratorExpressionNode[]
  ): ProjectionModelSpreadPropertyNode {
    parseExpected(Token.Ellipsis);

    reportInvalidDecorators(decorators, "spread property");

    const target = parseProjectionExpression();

    return {
      kind: SyntaxKind.ProjectionModelSpreadProperty,
      target,
      ...finishNode(pos),
    };
  }

  function parseProjectionModelProperty(
    pos: number,
    decorators: DecoratorExpressionNode[]
  ): ProjectionModelPropertyNode | ProjectionModelSpreadPropertyNode {
    const id = token() === Token.StringLiteral ? parseStringLiteral() : parseIdentifier("property");

    const optional = parseOptional(Token.Question);
    parseExpected(Token.Colon);
    const value = parseProjectionExpression();

    const hasDefault = parseOptional(Token.Equals);
    if (hasDefault && !optional) {
      error({ code: "default-optional" });
    }
    const defaultValue = hasDefault ? parseProjectionExpression() : undefined;
    return {
      kind: SyntaxKind.ProjectionModelProperty,
      id,
      decorators,
      value,
      optional,
      default: defaultValue,
      ...finishNode(pos),
    };
  }

  function parseProjectionIfExpression(): ProjectionIfExpressionNode {
    const pos = tokenPos();
    parseExpected(Token.IfKeyword);
    const test = parseProjectionExpression();
    const consequent = parseProjectionBlockExpression();
    let alternate = undefined;
    if (parseOptional(Token.ElseKeyword)) {
      if (token() === Token.IfKeyword) {
        alternate = parseProjectionIfExpression();
      } else {
        alternate = parseProjectionBlockExpression();
      }
    }

    return {
      kind: SyntaxKind.ProjectionIfExpression,
      test,
      consequent,
      alternate,
      ...finishNode(pos),
    };
  }

  function parseProjectionBlockExpression(): ProjectionBlockExpressionNode {
    const pos = tokenPos();
    parseExpected(Token.OpenBrace);
    const statements = parseProjectionStatementList();
    parseExpected(Token.CloseBrace);
    return {
      kind: SyntaxKind.ProjectionBlockExpression,
      statements,
      ...finishNode(pos),
    };
  }

  function parseProjectionTupleExpression(): ProjectionTupleExpressionNode {
    const pos = tokenPos();
    const values = parseList(ListKind.Tuple, parseProjectionExpression);
    return {
      kind: SyntaxKind.ProjectionTupleExpression,
      values,
      ...finishNode(pos),
    };
  }
  function parseProjectionSelector():
    | IdentifierNode
    | MemberExpressionNode
    | ProjectionInterfaceSelectorNode
    | ProjectionModelSelectorNode
    | ProjectionOperationSelectorNode
    | ProjectionUnionSelectorNode
    | ProjectionEnumSelectorNode {
    const pos = tokenPos();
    const selectorTok = expectTokenIsOneOf(
      Token.Identifier,
      Token.ModelKeyword,
      Token.OpKeyword,
      Token.InterfaceKeyword,
      Token.UnionKeyword,
      Token.EnumKeyword
    );

    switch (selectorTok) {
      case Token.Identifier:
        return parseIdentifierOrMemberExpression(undefined, true);
      case Token.ModelKeyword:
        nextToken();
        return {
          kind: SyntaxKind.ProjectionModelSelector,
          ...finishNode(pos),
        };
      case Token.OpKeyword:
        nextToken();
        return {
          kind: SyntaxKind.ProjectionOperationSelector,
          ...finishNode(pos),
        };
      case Token.InterfaceKeyword:
        nextToken();
        return {
          kind: SyntaxKind.ProjectionInterfaceSelector,
          ...finishNode(pos),
        };
      case Token.UnionKeyword:
        nextToken();
        return {
          kind: SyntaxKind.ProjectionUnionSelector,
          ...finishNode(pos),
        };
      case Token.EnumKeyword:
        nextToken();
        return {
          kind: SyntaxKind.ProjectionEnumSelector,
          ...finishNode(pos),
        };
      default:
        // recovery: return a missing identifier to use as the selector
        // we don't need to emit a diagnostic here as the `expectTokenOneOf` above
        // will have done so.
        return createMissingIdentifier();
    }
  }

  function parseRange<T>(mode: ParseMode, range: TextRange, callback: () => T): T {
    const savedMode = currentMode;
    const result = scanner.scanRange(range, () => {
      currentMode = mode;
      nextToken();
      return callback();
    });
    currentMode = savedMode;
    return result;
  }

  /** Remove leading slash-star-star and trailing  star-slash (if terminated) from doc comment range. */
  function innerDocRange(range: TextRange): TextRange {
    return {
      pos: range.pos + 3,
      end: tokenFlags() & TokenFlags.Unterminated ? range.end : range.end - 2,
    };
  }

  function parseDocList(): [pos: number, nodes: DocNode[]] {
    if (docRanges.length === 0 || !options.docs) {
      return [tokenPos(), []];
    }
    const docs: DocNode[] = [];
    for (const range of docRanges) {
      const doc = parseRange(ParseMode.Doc, innerDocRange(range), parseDoc);
      docs.push(doc);
    }

    return [docRanges[0].pos, docs];
  }

  function parseDoc(): DocNode {
    const pos = tokenPos();
    const content: DocContent[] = [];
    const tags: DocTag[] = [];

    loop: while (true) {
      switch (token()) {
        case Token.EndOfFile:
          break loop;
        case Token.At:
          const tag = parseDocTag();
          tags.push(tag);
          break;
        default:
          content.push(...parseDocContent());
          break;
      }
    }

    return {
      kind: SyntaxKind.Doc,
      content,
      tags,
      ...finishNode(pos),
    };
  }

  function parseDocContent(): DocContent[] {
    const parts: string[] = [];
    const source = scanner.file.text;
    const pos = tokenPos();

    let start = pos;
    let inCodeFence = false;

    loop: while (true) {
      switch (token()) {
        case Token.DocCodeFenceDelimiter:
          inCodeFence = !inCodeFence;
          nextDocToken();
          break;
        case Token.NewLine:
          parts.push(source.substring(start, tokenPos()));
          parts.push("\n"); // normalize line endings
          nextDocToken();
          start = tokenPos();
          while (parseOptional(Token.Whitespace));
          if (parseOptional(Token.Star)) {
            parseOptional(Token.Whitespace);
            start = tokenPos();
            break;
          }
          break;
        case Token.EndOfFile:
          break loop;
        case Token.At:
          if (!inCodeFence) {
            break loop;
          }
          nextDocToken();
          break;
        default:
          nextDocToken();
          break;
      }
    }

    parts.push(source.substring(start, tokenPos()));
    const text = trim(parts.join(""));

    return [
      {
        kind: SyntaxKind.DocText,
        text,
        ...finishNode(pos),
      },
    ];
  }

  type ParamLikeTag = DocTemplateTagNode | DocParamTagNode;
  type SimpleTag = DocReturnsTagNode | DocUnknownTagNode;

  function parseDocTag(): DocTag {
    const pos = tokenPos();
    parseExpected(Token.At);
    const tagName = parseDocIdentifier("tag");
    switch (tagName.sv) {
      case "param":
        return parseDocParamLikeTag(pos, tagName, SyntaxKind.DocParamTag, "param");
      case "template":
        return parseDocParamLikeTag(pos, tagName, SyntaxKind.DocTemplateTag, "templateParam");
      case "return":
      case "returns":
        return parseDocSimpleTag(pos, tagName, SyntaxKind.DocReturnsTag);
      default:
        return parseDocSimpleTag(pos, tagName, SyntaxKind.DocUnknownTag);
    }
  }

  function parseDocParamLikeTag(
    pos: number,
    tagName: IdentifierNode,
    kind: ParamLikeTag["kind"],
    messageId: keyof CompilerDiagnostics["doc-invalid-identifier"]
  ): ParamLikeTag {
    const name = parseDocIdentifier(messageId);
    const content = parseDocContent();
    return {
      kind,
      tagName,
      paramName: name,
      content,
      ...finishNode(pos),
    };
  }

  function parseDocSimpleTag(
    pos: number,
    tagName: IdentifierNode,
    kind: SimpleTag["kind"]
  ): SimpleTag {
    const content = parseDocContent();
    return {
      kind,
      tagName,
      content,
      ...finishNode(pos),
    };
  }

  function parseDocIdentifier(
    messageId: keyof CompilerDiagnostics["doc-invalid-identifier"]
  ): IdentifierNode {
    // We don't allow whitespace between @ and tag name, but allow
    // whitespace before all other identifiers.
    if (messageId !== "tag") {
      while (parseOptional(Token.Whitespace));
    }

    const pos = tokenPos();
    let sv: string;

    if (token() === Token.Identifier) {
      sv = tokenValue();
      nextDocToken();
    } else {
      sv = "";
      warning({ code: "doc-invalid-identifier", messageId });
    }

    return {
      kind: SyntaxKind.Identifier,
      sv,
      ...finishNode(pos),
    };
  }

  // utility functions
  function token() {
    return scanner.token;
  }

  function tokenFlags() {
    return scanner.tokenFlags;
  }

  function tokenValue() {
    return scanner.getTokenValue();
  }

  function tokenPos() {
    return scanner.tokenPosition;
  }

  function tokenEnd() {
    return scanner.position;
  }

  function nextToken() {
    // keep track of the previous token end separately from the current scanner
    // position as these will differ when the previous token had trailing
    // trivia, and we don't want to squiggle the trivia.
    previousTokenEnd = scanner.position;
    return currentMode === ParseMode.Syntax ? nextSyntaxToken() : nextDocToken();
  }

  function nextSyntaxToken() {
    docRanges = [];

    for (;;) {
      scanner.scan();
      if (isTrivia(token())) {
        if (!newLineIsTrivia && token() === Token.NewLine) {
          break;
        }
        if (tokenFlags() & TokenFlags.DocComment) {
          docRanges.push({
            pos: tokenPos(),
            end: tokenEnd(),
          });
        }
        if (options.comments && isComment(token())) {
          comments.push({
            kind:
              token() === Token.SingleLineComment
                ? SyntaxKind.LineComment
                : SyntaxKind.BlockComment,
            pos: tokenPos(),
            end: tokenEnd(),
          });
        }
      } else {
        break;
      }
    }
  }

  function nextDocToken() {
    // NOTE: trivia tokens are always significant in doc comments.
    scanner.scanDoc();
  }

  function createMissingIdentifier(): IdentifierNode {
    const pos = tokenPos();
    previousTokenEnd = pos;
    missingIdentifierCounter++;

    return {
      kind: SyntaxKind.Identifier,
      sv: "<missing identifier>" + missingIdentifierCounter,
      ...finishNode(pos),
    };
  }

  function finishNode(pos: number): TextRange & { flags: NodeFlags; symbol: Sym } {
    const flags = parseErrorInNextFinishedNode ? NodeFlags.ThisNodeHasError : NodeFlags.None;
    parseErrorInNextFinishedNode = false;
    return withSymbol({ pos, end: previousTokenEnd, flags });
  }

  // pretend to add as symbol property, likely to a node that is being created.
  function withSymbol<T extends { symbol: Sym }>(obj: Omit<T, "symbol">): T {
    return obj as any;
  }

  /**
   * Parse a delimited list of elements, including the surrounding open and
   * close punctuation
   *
   * This shared driver function is used to share sensitive error recovery code.
   * In particular, error recovery by inserting tokens deemed missing is
   * susceptible to getting stalled in a loop iteration without making any
   * progress, and we guard against this in a shared place here.
   *
   * Note that statement and decorator lists do not have this issue. We always
   * consume at least a real '@' for a decorator and if the leading token of a
   * statement is not one of our statement keywords, ';', or '@', it is consumed
   * as part of a bad statement. As such, parsing of decorators and statements
   * do not go through here.
   */
  function parseList<K extends ListKind, T extends Node>(
    kind: K,
    parseItem: ParseListItem<K, T>
  ): T[] {
    if (kind.open !== Token.None) {
      parseExpected(kind.open);
    }

    if (kind.allowEmpty && parseOptional(kind.close)) {
      return [];
    }

    const items: T[] = [];
    while (true) {
      let pos = tokenPos();
      let docs: DocNode[] | undefined;

      if (!kind.invalidAnnotationTarget) {
        [pos, docs] = parseDocList();
      }
      const directives = parseDirectiveList();
      const decorators = parseDecoratorList();
      if (kind.invalidAnnotationTarget) {
        reportInvalidDecorators(decorators, kind.invalidAnnotationTarget);
        reportInvalidDirective(directives, kind.invalidAnnotationTarget);
      }

      if (directives.length === 0 && decorators.length === 0 && atEndOfListWithError(kind)) {
        // Error recovery: end surrounded list at statement keyword or end
        // of file. Note, however, that we must parse a missing element if
        // there were directives or decorators as we cannot drop those from
        // the tree.
        parseExpected(kind.close);
        break;
      }

      let item: T;
      if (kind.invalidAnnotationTarget) {
        item = (parseItem as ParseListItem<UnannotatedListKind, T>)();
      } else {
        item = parseItem(pos, decorators);
        mutate(item).docs = docs;
        mutate(item).directives = directives;
      }

      items.push(item);
      const delimiter = token();
      const delimiterPos = tokenPos();

      if (parseOptionalDelimiter(kind)) {
        // Delimiter found: check if it's trailing.
        if (parseOptional(kind.close)) {
          if (!kind.trailingDelimiterIsValid) {
            error({
              code: "trailing-token",
              format: { token: TokenDisplay[delimiter] },
              target: {
                pos: delimiterPos,
                end: delimiterPos + 1,
              },
            });
          }
          // It was trailing and we've consumed the close token.
          break;
        }
        // Not trailing. We can safely skip the progress check below here
        // because we know that we consumed a real delimiter.
        continue;
      } else if (kind.close === Token.None) {
        // If a list is *not* surrounded by punctuation, then the list ends when
        // there's no delimiter after an item.
        break;
      } else if (parseOptional(kind.close)) {
        // If a list *is* surrounded by punctuation, then the list ends when we
        // reach the close token.
        break;
      } else if (atEndOfListWithError(kind)) {
        // Error recovery: If a list *is* surrounded by punctuation, then
        // the list ends at statement keyword or end-of-file under the
        // assumption that the closing delimiter is missing. This check is
        // duplicated from above to preempt the parseExpected(delimeter)
        // below.
        parseExpected(kind.close);
        break;
      } else {
        // Error recovery: if a list kind *is* surrounded by punctuation and we
        // find neither a delimiter nor a close token after an item, then we
        // assume there is a missing delimiter between items.
        //
        // Example: `model M { a: B <missing semicolon> c: D }
        parseExpected(kind.delimiter);
      }

      if (pos === tokenPos()) {
        // Error recovery: we've inserted everything during this loop iteration
        // and haven't made any progress. Assume that the current token is a bad
        // representation of the end of the the list that we're trying to get
        // through.
        //
        // Simple repro: `model M { ]` would loop forever without this check.
        //
        parseExpected(kind.close);
        nextToken();

        // remove the item that was entirely inserted by error recovery.
        items.pop();
        break;
      }
    }

    return items;
  }

  /**
   * Parse a delimited list with surrounding open and close punctuation if the
   * open token is present. Otherwise, return an empty list.
   */
  function parseOptionalList<K extends SurroundedListKind, T extends Node>(
    kind: K,
    parseItem: ParseListItem<K, T>
  ): T[] {
    return token() === kind.open ? parseList(kind, parseItem) : [];
  }

  function parseOptionalDelimiter(kind: ListKind) {
    if (parseOptional(kind.delimiter)) {
      return true;
    }

    if (token() === kind.toleratedDelimiter) {
      if (!kind.toleratedDelimiterIsValid) {
        parseExpected(kind.delimiter);
      }
      nextToken();
      return true;
    }

    return false;
  }

  function atEndOfListWithError(kind: ListKind) {
    return (
      kind.close !== Token.None &&
      (isStatementKeyword(token()) || token() === Token.EndOfFile) &&
      token() !== kind.allowedStatementKeyword
    );
  }

  function parseEmptyStatement(pos: number): EmptyStatementNode {
    parseExpected(Token.Semicolon);
    return { kind: SyntaxKind.EmptyStatement, ...finishNode(pos) };
  }

  function parseInvalidStatement(
    pos: number,
    decorators: DecoratorExpressionNode[]
  ): InvalidStatementNode {
    // Error recovery: avoid an avalanche of errors when we get cornered into
    // parsing statements where none exist. Skip until we find a statement
    // keyword or decorator and only report one error for a contiguous range of
    // neither.
    do {
      nextToken();
    } while (
      !isStatementKeyword(token()) &&
      token() !== Token.At &&
      token() !== Token.Semicolon &&
      token() !== Token.EndOfFile
    );

    error({
      code: "token-expected",
      messageId: "statement",
      target: { pos, end: previousTokenEnd },
    });
    return { kind: SyntaxKind.InvalidStatement, decorators, ...finishNode(pos) };
  }

  function error<
    C extends keyof CompilerDiagnostics,
    M extends keyof CompilerDiagnostics[C] = "default"
  >(
    report: DiagnosticReportWithoutTarget<CompilerDiagnostics, C, M> & {
      target?: Partial<TextRange> & { realPos?: number };
      printable?: boolean;
    }
  ) {
    parseErrorInNextFinishedNode = true;

    const location = {
      file: scanner.file,
      pos: report.target?.pos ?? tokenPos(),
      end: report.target?.end ?? tokenEnd(),
    };

    if (!report.printable) {
      treePrintable = false;
    }

    // Error recovery: don't report more than 1 consecutive error at the same
    // position. The code path taken by error recovery after logging an error
    // can otherwise produce redundant and less decipherable errors, which this
    // suppresses.
    const realPos = report.target?.realPos ?? location.pos;
    if (realPositionOfLastError === realPos) {
      return;
    }
    realPositionOfLastError = realPos;

    const diagnostic = createDiagnostic({
      ...report,
      target: location,
    } as any);

    assert(
      diagnostic.severity === "error",
      "This function is for reporting errors. Use warning() for warnings."
    );

    parseDiagnostics.push(diagnostic);
  }

  function warning<
    C extends keyof CompilerDiagnostics,
    M extends keyof CompilerDiagnostics[C] = "default"
  >(
    report: DiagnosticReportWithoutTarget<CompilerDiagnostics, C, M> & {
      target?: Partial<TextRange>;
    }
  ) {
    const location = {
      file: scanner.file,
      pos: report.target?.pos ?? tokenPos(),
      end: report.target?.end ?? tokenEnd(),
    };

    const diagnostic = createDiagnostic({
      ...report,
      target: location,
    } as any);

    assert(
      diagnostic.severity === "warning",
      "This function is for reporting warnings only. Use error() for errors."
    );

    parseDiagnostics.push(diagnostic);
  }

  function reportDiagnostic(diagnostic: Diagnostic) {
    if (diagnostic.severity === "error") {
      parseErrorInNextFinishedNode = true;
      treePrintable = false;
    }
    parseDiagnostics.push(diagnostic);
  }

  function assert(condition: boolean, message: string): asserts condition {
    const location = {
      file: scanner.file,
      pos: tokenPos(),
      end: tokenEnd(),
    };
    compilerAssert(condition, message, location);
  }

  function reportInvalidDecorators(decorators: DecoratorExpressionNode[], nodeName: string) {
    for (const decorator of decorators) {
      error({ code: "invalid-decorator-location", format: { nodeName }, target: decorator });
    }
  }
  function reportInvalidDirective(directives: DirectiveExpressionNode[], nodeName: string) {
    for (const directive of directives) {
      error({ code: "invalid-directive-location", format: { nodeName }, target: directive });
    }
  }

  function parseExpected(expectedToken: Token) {
    if (token() === expectedToken) {
      nextToken();
      return true;
    }

    const location = getAdjustedDefaultLocation(expectedToken);
    error({
      code: "token-expected",
      format: { token: TokenDisplay[expectedToken] },
      target: location,
      printable: isPunctuation(expectedToken),
    });
    return false;
  }

  function expectTokenIsOneOf(...args: [option1: Token, ...rest: Token[]]) {
    const tok = token();
    for (const expected of args) {
      if (expected === Token.None) {
        continue;
      }
      if (tok === expected) {
        return tok;
      }
    }
    errorTokenIsNotOneOf(...args);
    return Token.None;
  }

  function parseExpectedOneOf(...args: [option1: Token, ...rest: Token[]]) {
    const tok = expectTokenIsOneOf(...args);
    if (tok !== Token.None) {
      nextToken();
    }
    return tok;
  }

  function errorTokenIsNotOneOf(...args: [option1: Token, ...rest: Token[]]) {
    const location = getAdjustedDefaultLocation(args[0]);
    const displayList = args.map((t, i) => {
      if (i === args.length - 1) {
        return `or ${TokenDisplay[t]}`;
      }
      return TokenDisplay[t];
    });
    error({ code: "token-expected", format: { token: displayList.join(", ") }, target: location });
  }

  function parseOptional(optionalToken: Token) {
    if (token() === optionalToken) {
      nextToken();
      return true;
    }

    return false;
  }

  function getAdjustedDefaultLocation(token: Token) {
    // Put the squiggly immediately after prior token when missing punctuation.
    // Avoids saying ';' is expected far away after a long comment, for example.
    // It's also confusing to squiggle the current token even if its nearby
    // in this case.
    return isPunctuation(token)
      ? { pos: previousTokenEnd, end: previousTokenEnd + 1, realPos: tokenPos() }
      : undefined;
  }
}

export type NodeCallback<T> = (c: Node) => T;

export function visitChildren<T>(node: Node, cb: NodeCallback<T>): T | undefined {
  if (node.directives) {
    const result = visitEach(cb, node.directives);
    if (result) return result;
  }
  if (node.docs) {
    const result = visitEach(cb, node.docs);
    if (result) return result;
  }

  switch (node.kind) {
    case SyntaxKind.CadlScript:
      return visitNode(cb, node.id) || visitEach(cb, node.statements);
    case SyntaxKind.ArrayExpression:
      return visitNode(cb, node.elementType);
    case SyntaxKind.AugmentDecoratorStatement:
      return (
        visitNode(cb, node.target) ||
        visitNode(cb, node.targetType) ||
        visitEach(cb, node.arguments)
      );
    case SyntaxKind.DecoratorExpression:
      return visitNode(cb, node.target) || visitEach(cb, node.arguments);
    case SyntaxKind.DirectiveExpression:
      return visitNode(cb, node.target) || visitEach(cb, node.arguments);
    case SyntaxKind.ImportStatement:
      return visitNode(cb, node.path);
    case SyntaxKind.OperationStatement:
      return (
        visitEach(cb, node.decorators) ||
        visitNode(cb, node.id) ||
        visitEach(cb, node.templateParameters) ||
        visitNode(cb, node.signature)
      );
    case SyntaxKind.OperationSignatureDeclaration:
      return visitNode(cb, node.parameters) || visitNode(cb, node.returnType);
    case SyntaxKind.OperationSignatureReference:
      return visitNode(cb, node.baseOperation);
    case SyntaxKind.NamespaceStatement:
      return (
        visitEach(cb, node.decorators) ||
        visitNode(cb, node.id) ||
        (isArray(node.statements) ? visitEach(cb, node.statements) : visitNode(cb, node.statements))
      );
    case SyntaxKind.InterfaceStatement:
      return (
        visitEach(cb, node.decorators) ||
        visitNode(cb, node.id) ||
        visitEach(cb, node.templateParameters) ||
        visitEach(cb, node.extends) ||
        visitEach(cb, node.operations)
      );
    case SyntaxKind.UsingStatement:
      return visitNode(cb, node.name);
    case SyntaxKind.IntersectionExpression:
      return visitEach(cb, node.options);
    case SyntaxKind.MemberExpression:
      return visitNode(cb, node.base) || visitNode(cb, node.id);
    case SyntaxKind.ModelExpression:
      return visitEach(cb, node.properties);
    case SyntaxKind.ModelProperty:
      return (
        visitEach(cb, node.decorators) ||
        visitNode(cb, node.id) ||
        visitNode(cb, node.value) ||
        visitNode(cb, node.default)
      );
    case SyntaxKind.ModelSpreadProperty:
      return visitNode(cb, node.target);
    case SyntaxKind.ModelStatement:
      return (
        visitEach(cb, node.decorators) ||
        visitNode(cb, node.id) ||
        visitEach(cb, node.templateParameters) ||
        visitNode(cb, node.extends) ||
        visitNode(cb, node.is) ||
        visitEach(cb, node.properties)
      );
    case SyntaxKind.ScalarStatement:
      return (
        visitEach(cb, node.decorators) ||
        visitNode(cb, node.id) ||
        visitEach(cb, node.templateParameters) ||
        visitNode(cb, node.extends)
      );
    case SyntaxKind.UnionStatement:
      return (
        visitEach(cb, node.decorators) ||
        visitNode(cb, node.id) ||
        visitEach(cb, node.templateParameters) ||
        visitEach(cb, node.options)
      );
    case SyntaxKind.UnionVariant:
      return visitEach(cb, node.decorators) || visitNode(cb, node.id) || visitNode(cb, node.value);
    case SyntaxKind.EnumStatement:
      return (
        visitEach(cb, node.decorators) || visitNode(cb, node.id) || visitEach(cb, node.members)
      );
    case SyntaxKind.EnumMember:
      return visitEach(cb, node.decorators) || visitNode(cb, node.id) || visitNode(cb, node.value);
    case SyntaxKind.EnumSpreadMember:
      return visitNode(cb, node.target);
    case SyntaxKind.AliasStatement:
      return (
        visitNode(cb, node.id) ||
        visitEach(cb, node.templateParameters) ||
        visitNode(cb, node.value)
      );
    case SyntaxKind.DecoratorDeclarationStatement:
      return (
        visitEach(cb, node.modifiers) ||
        visitNode(cb, node.id) ||
        visitNode(cb, node.target) ||
        visitEach(cb, node.parameters)
      );
    case SyntaxKind.FunctionDeclarationStatement:
      return (
        visitEach(cb, node.modifiers) ||
        visitNode(cb, node.id) ||
        visitEach(cb, node.parameters) ||
        visitNode(cb, node.returnType)
      );
    case SyntaxKind.FunctionParameter:
      return visitNode(cb, node.id) || visitNode(cb, node.type);
    case SyntaxKind.TypeReference:
      return visitNode(cb, node.target) || visitEach(cb, node.arguments);
    case SyntaxKind.TupleExpression:
      return visitEach(cb, node.values);
    case SyntaxKind.UnionExpression:
      return visitEach(cb, node.options);

    case SyntaxKind.Projection:
      return (
        visitNode(cb, node.directionId) ||
        visitEach(cb, node.parameters) ||
        visitEach(cb, node.body)
      );
    case SyntaxKind.ProjectionExpressionStatement:
      return visitNode(cb, node.expr);
    case SyntaxKind.ProjectionCallExpression:
      return visitNode(cb, node.target) || visitEach(cb, node.arguments);
    case SyntaxKind.ProjectionMemberExpression:
      return visitNode(cb, node.base) || visitNode(cb, node.id);
    // binops
    case SyntaxKind.ProjectionLogicalExpression:
    case SyntaxKind.ProjectionRelationalExpression:
    case SyntaxKind.ProjectionArithmeticExpression:
    case SyntaxKind.ProjectionEqualityExpression:
      return visitNode(cb, node.left) || visitNode(cb, node.right);
    case SyntaxKind.ProjectionUnaryExpression:
      return visitNode(cb, node.target);
    case SyntaxKind.ProjectionModelExpression:
      return visitEach(cb, node.properties);
    case SyntaxKind.ProjectionModelProperty:
      return (
        visitEach(cb, node.decorators) ||
        visitNode(cb, node.id) ||
        visitNode(cb, node.value) ||
        visitNode(cb, node.default)
      );
    case SyntaxKind.ProjectionModelSpreadProperty:
      return visitNode(cb, node.target);
    case SyntaxKind.ProjectionTupleExpression:
      return visitEach(cb, node.values);
    case SyntaxKind.ProjectionBlockExpression:
      return visitEach(cb, node.statements);
    case SyntaxKind.ProjectionIfExpression:
      return (
        visitNode(cb, node.test) || visitNode(cb, node.consequent) || visitNode(cb, node.alternate)
      );
    case SyntaxKind.ProjectionLambdaExpression:
      return visitEach(cb, node.parameters) || visitNode(cb, node.body);
    case SyntaxKind.ProjectionStatement:
      return (
        visitNode(cb, node.id) ||
        visitNode(cb, node.selector) ||
        visitNode(cb, node.from) ||
        visitNode(cb, node.to)
      );
    case SyntaxKind.ProjectionDecoratorReferenceExpression:
      return visitNode(cb, node.target);
    case SyntaxKind.Return:
      return visitNode(cb, node.value);
    case SyntaxKind.InvalidStatement:
      return visitEach(cb, node.decorators);
    case SyntaxKind.TemplateParameterDeclaration:
      return (
        visitNode(cb, node.id) || visitNode(cb, node.constraint) || visitNode(cb, node.default)
      );
    case SyntaxKind.ProjectionLambdaParameterDeclaration:
      return visitNode(cb, node.id);
    case SyntaxKind.ProjectionParameterDeclaration:
      return visitNode(cb, node.id);
    case SyntaxKind.Doc:
      return visitEach(cb, node.content) || visitEach(cb, node.tags);
    case SyntaxKind.DocParamTag:
    case SyntaxKind.DocTemplateTag:
      return (
        visitNode(cb, node.tagName) || visitNode(cb, node.paramName) || visitEach(cb, node.content)
      );
    case SyntaxKind.DocReturnsTag:
    case SyntaxKind.DocUnknownTag:
      return visitNode(cb, node.tagName) || visitEach(cb, node.content);

    // no children for the rest of these.
    case SyntaxKind.StringLiteral:
    case SyntaxKind.NumericLiteral:
    case SyntaxKind.BooleanLiteral:
    case SyntaxKind.Identifier:
    case SyntaxKind.EmptyStatement:
    case SyntaxKind.ProjectionModelSelector:
    case SyntaxKind.ProjectionUnionSelector:
    case SyntaxKind.ProjectionInterfaceSelector:
    case SyntaxKind.ProjectionOperationSelector:
    case SyntaxKind.ProjectionEnumSelector:
    case SyntaxKind.VoidKeyword:
    case SyntaxKind.NeverKeyword:
    case SyntaxKind.ExternKeyword:
    case SyntaxKind.UnknownKeyword:
    case SyntaxKind.JsSourceFile:
    case SyntaxKind.DocText:
      return;

    default:
      // Dummy const to ensure we handle all node types.
      // If you get an error here, add a case for the new node type
      // you added..
      const _assertNever: never = node;
      return;
  }
}

function visitNode<T>(cb: NodeCallback<T>, node: Node | undefined): T | undefined {
  return node && cb(node);
}

function visitEach<T>(cb: NodeCallback<T>, nodes: readonly Node[] | undefined): T | undefined {
  if (!nodes) {
    return;
  }

  for (const node of nodes) {
    const result = cb(node);
    if (result) {
      return result;
    }
  }
  return;
}

/**
 * Resolve the node in the syntax tree that that is at the given position.
 * @param script Cadl Script node
 * @param position Position
 * @param filter Filter if wanting to return a parent containing node early.
 */
export function getNodeAtPosition(
  script: CadlScriptNode,
  position: number,
  filter = (node: Node) => true
): Node | undefined {
  return visit(script);

  function visit(node: Node): Node | undefined {
    // We deliberately include the end position here because we need to hit
    // nodes when the cursor is positioned immediately after an identifier.
    // This is especially vital for completion. It's also generally OK
    // because the language doesn't (and should never) have syntax where you
    // could place the cursor ambiguously between two adjacent,
    // non-punctuation, non-trivia tokens that have no punctuation or trivia
    // separating them.
    if (node.pos <= position && position <= node.end) {
      // We only need to recursively visit children of nodes that satisfied
      // the condition above and therefore contain the given position. If a
      // node does not contain a position, then neither do its children.
      const child = visitChildren(node, visit);

      // A child match here is better than a self-match below as we want the
      // deepest (most specific) node. In other words, the search is depth
      // first. For example, consider `A<B<C>>`: If the cursor is on `B`,
      // then prefer B<C> over A<B<C>>.
      if (child) {
        return child;
      }

      if (filter(node)) {
        return node;
      }
    }

    return undefined;
  }
}

export function hasParseError(node: Node) {
  if (node.flags & NodeFlags.ThisNodeHasError) {
    return true;
  }

  checkForDescendantErrors(node);
  return node.flags & NodeFlags.DescendantHasError;
}

function checkForDescendantErrors(node: Node) {
  if (node.flags & NodeFlags.DescendantErrorsExamined) {
    return;
  }
  mutate(node).flags |= NodeFlags.DescendantErrorsExamined;

  visitChildren(node, (child: Node) => {
    if (child.flags & NodeFlags.ThisNodeHasError) {
      mutate(node).flags |= NodeFlags.DescendantHasError | NodeFlags.DescendantErrorsExamined;
      return true;
    }
    checkForDescendantErrors(child);

    if (child.flags & NodeFlags.DescendantHasError) {
      mutate(node).flags |= NodeFlags.DescendantHasError | NodeFlags.DescendantErrorsExamined;
      return true;
    }
    mutate(child).flags |= NodeFlags.DescendantErrorsExamined;

    return false;
  });
}

export function isImportStatement(node: Node): node is ImportStatementNode {
  return node.kind === SyntaxKind.ImportStatement;
}

function isBlocklessNamespace(node: Node) {
  if (node.kind !== SyntaxKind.NamespaceStatement) {
    return false;
  }
  while (!isArray(node.statements) && node.statements) {
    node = node.statements;
  }

  return node.statements === undefined;
}

export function getFirstAncestor(node: Node, test: NodeCallback<boolean>): Node | undefined {
  for (let n = node.parent; n; n = n.parent) {
    if (test(n)) {
      return n;
    }
  }
  return undefined;
}

export function getIdentifierContext(id: IdentifierNode): IdentifierContext {
  const node = getFirstAncestor(id, (n) => n.kind !== SyntaxKind.MemberExpression);
  compilerAssert(node, "Identifier with no non-member-expression ancestor.");

  let kind: IdentifierKind;
  switch (node.kind) {
    case SyntaxKind.TypeReference:
      kind = IdentifierKind.TypeReference;
      break;
    case SyntaxKind.AugmentDecoratorStatement:
    case SyntaxKind.DecoratorExpression:
      kind = IdentifierKind.Decorator;
      break;
    case SyntaxKind.ProjectionCallExpression:
      kind = IdentifierKind.Function;
      break;
    case SyntaxKind.UsingStatement:
      kind = IdentifierKind.Using;
      break;
    default:
      kind =
        (id.parent as DeclarationNode).id === id
          ? IdentifierKind.Declaration
          : IdentifierKind.Other;
      break;
  }

  return { node, kind };
}
