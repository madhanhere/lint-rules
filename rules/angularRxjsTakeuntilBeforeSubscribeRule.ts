/**
 * @license Use of this source code is governed by an MIT-style license that
 * can be found in the LICENSE file at https://github.com/cartant/rxjs-tslint-rules
 */
/*tslint:disable:no-use-before-declare*/

import * as Lint from "tslint";
import * as tsutils from "tsutils";
import * as ts from "typescript";
import { couldBeType } from "tsutils-etc";
import { tsquery } from "@phenomnomnominal/tsquery";
import { dedent } from "tslint/lib/utils";

export class Rule extends Lint.Rules.TypedRule {
  public static metadata: Lint.IRuleMetadata = {
    description: dedent`Enforces the application of the takeUntil operator
                        when calling of subscribe within an Angular component or directive.`,
    options: null,
    optionsDescription: "",
    requiresTypeInfo: true,
    ruleName: "angular-rxjs-takeuntil-before-subscribe",
    type: "functionality",
    typescriptOnly: true
  };

  public static FAILURE_STRING =
    "subscribe within a component must be preceded by takeUntil";

  public static FAILURE_STRING_SUBJECT_NAME =
    "takeUntil argument must be a property of the class, e.g. takeUntil(this.destroy$)";

  public static FAILURE_STRING_OPERATOR =
    "the {operator} operator used within a component must be preceded by takeUntil";

  public static FAILURE_STRING_NG_ON_DESTROY =
    "component containing subscribe must implement the ngOnDestroy() method";

  public static FAILURE_STRING_NG_ON_DESTROY_SUBJECT_METHOD_NOT_CALLED =
    "there must be an invocation of {destroySubjectName}.{methodName}() in ngOnDestroy()";

  private operatorsRequiringPrecedingTakeuntil: string[] = [
    "shareReplay"
  ];

  private ignoreOperatorsWithRefCountTrue: string[] = [
    "shareReplay"
  ];

  public applyWithProgram(
    sourceFile: ts.SourceFile,
    program: ts.Program
  ): Lint.RuleFailure[] {
    const failures: Lint.RuleFailure[] = [];

    // find all classes with an @Component() decorator
    const componentClassDeclarations = tsquery(
      sourceFile,
      `ClassDeclaration:has(Decorator[expression.expression.name='Component'])`
    ) as ts.ClassDeclaration[];
    // find all classes with an @Directive() decorator
    const directiveClassDeclarations = tsquery(
      sourceFile,
      `ClassDeclaration:has(Decorator[expression.expression.name='Directive'])`
    ) as ts.ClassDeclaration[];

    [
        ...componentClassDeclarations,
        ...directiveClassDeclarations,
        // get all parent classes of all component class declarations
        ...componentClassDeclarations.map(classDeclaration => this.findParentClasses(program, classDeclaration))
            .reduce((classDeclarations, parentClassDeclaration) => [...classDeclarations, ...parentClassDeclaration], []),
      // get all parent classes of all directive class declarations
        ...directiveClassDeclarations.map(classDeclaration => this.findParentClasses(program, classDeclaration))
            .reduce((classDeclarations, parentClassDeclaration) => [...classDeclarations, ...parentClassDeclaration], [])
    ].forEach(componentClassDeclaration => {
      failures.push(
        ...this.checkComponentClassDeclaration(
          componentClassDeclaration.getSourceFile(),
          program,
          componentClassDeclaration
        )
      );

    });

    return failures;
  }

  /**
   * recursively find all parent classes of the classe given
   */
  private findParentClasses(
      program: ts.Program,
      classDeclarationToBeChecked: ts.ClassDeclaration
  ): ts.ClassDeclaration[] {
    const classDeclarationsFound: ts.ClassDeclaration[] = [];
    const typeChecker = program.getTypeChecker();

    const heritageClauses = classDeclarationToBeChecked.heritageClauses;

    if (!heritageClauses) {
      return [];
    }
    heritageClauses.forEach(heritageClause => {
      if(heritageClause.token === ts.SyntaxKind.ExtendsKeyword) {
        heritageClause.types.forEach(heritageClauseType => {
          if (!tsutils.isIdentifier(heritageClauseType.expression)) {
            return;
          }
          const extendType = typeChecker.getTypeAtLocation(heritageClauseType.expression);
          if (extendType && extendType.symbol
              && extendType.symbol.declarations
              && extendType.symbol.declarations.length > 0
              && tsutils.isClassDeclaration(extendType.symbol.declarations[0])
          ) {
            const parentClassDeclaration = extendType.symbol.declarations[0] as ts.ClassDeclaration;
            classDeclarationsFound.push(parentClassDeclaration);
            classDeclarationsFound.push(...this.findParentClasses(program, parentClassDeclaration))
          }
        })
      }
    });


    return classDeclarationsFound;
  };

  /**
   * Checks a component class for occurrences of .subscribe() and corresponding takeUntil() requirements
   */
  private checkComponentClassDeclaration(
    sourceFile: ts.SourceFile,
    program: ts.Program,
    componentClassDeclaration: ts.ClassDeclaration
  ): Lint.RuleFailure[] {
    const failures: Lint.RuleFailure[] = [];

    const typeChecker = program.getTypeChecker();
    /** list of destroy subjects used in takeUntil() operators */
    const destroySubjectNamesUsed: {
      [destroySubjectName: string]: boolean;
    } = {};

    // find observable.subscribe() call expressions
    const subscribePropertyAccessExpressions = tsquery(
      componentClassDeclaration,
      `CallExpression > PropertyAccessExpression[name.name="subscribe"]`
    );

    // check whether it is an observable and check the takeUntil before the subscribe
    subscribePropertyAccessExpressions.forEach(node => {
      const propertyAccessExpression = node as ts.PropertyAccessExpression;
      const type = typeChecker.getTypeAtLocation(
        propertyAccessExpression.expression
      );
      if (couldBeType(type, "Observable")) {
        const subscribeFailures = this.checkTakeuntilBeforeSubscribe(
          sourceFile,
          propertyAccessExpression
        );
        failures.push(...subscribeFailures.failures);
        if (subscribeFailures.destroySubjectName) {
          destroySubjectNamesUsed[subscribeFailures.destroySubjectName] = true;
        }
      }
    });

    // find observable.pipe() call expressions
    const pipePropertyAccessExpressions = tsquery(
      componentClassDeclaration,
      `CallExpression > PropertyAccessExpression[name.name="pipe"]`
    );

    // check whether it is an observable and check the takeUntil before operators requiring it
    pipePropertyAccessExpressions.forEach(node => {
      const propertyAccessExpression = node as ts.PropertyAccessExpression;
      const pipeCallExpression = node.parent as ts.CallExpression;
      const type = typeChecker.getTypeAtLocation(
        propertyAccessExpression.expression
      );
      if (couldBeType(type, "Observable")) {
        const pipeFailures = this.checkTakeuntilBeforeOperatorsInPipe(
          sourceFile,
          pipeCallExpression.arguments
        );
        failures.push(...pipeFailures.failures);
        pipeFailures.destroySubjectNames.forEach(destroySubjectName => {
          if (destroySubjectName) {
            destroySubjectNamesUsed[destroySubjectName] = true;
          }
        });
      }
    });

    // check the ngOnDestroyMethod
    const destroySubjectNamesUsedList = Object.keys(destroySubjectNamesUsed);
    destroySubjectNamesUsedList.forEach(destroySubjectNameUsed => {
      // look for ngOnDestroy in class and in all parent classes
      const classesToCheck = [
          componentClassDeclaration,
          ...this.findParentClasses(program, componentClassDeclaration)
      ];
      const ngOnDestroyFailuresList = classesToCheck.map(classDeclaration => this.checkNgOnDestroy(
          sourceFile,
          classDeclaration,
          destroySubjectNameUsed
      ));

      // if there is no correct implementation of ngOnDestroy in any of the classes to be checked
      if (ngOnDestroyFailuresList.length > 0 && !ngOnDestroyFailuresList.find(failures => failures.length === 0)) {
        failures.push(...ngOnDestroyFailuresList[0]);
      }
    });

    return failures;
  }

  /**
   * Checks whether a .subscribe() is preceded by a .pipe(<...>, takeUntil(<...>))
   */
  private checkTakeuntilBeforeSubscribe(
    sourceFile: ts.SourceFile,
    node: ts.PropertyAccessExpression
  ): { failures: Lint.RuleFailure[]; destroySubjectName: string | undefined } {
    const failures: Lint.RuleFailure[] = [];
    const subscribeContext = node.expression;

    /** Whether a takeUntil() operator preceding the .subscribe() was found */
    let lastTakeUntilFound = false;
    /** name of the takeUntil() argument */
    let destroySubjectName: string | undefined;

    // check whether subscribeContext.expression is <something>.pipe()
    if (
      tsutils.isCallExpression(subscribeContext) &&
      tsutils.isPropertyAccessExpression(subscribeContext.expression) &&
      subscribeContext.expression.name.getText() === "pipe"
    ) {
      const pipedOperators = subscribeContext.arguments;
      if (pipedOperators.length > 0) {
        const lastPipedOperator = pipedOperators[pipedOperators.length - 1];
        // check whether the last operator in the .pipe() call is takeUntil()
        if (tsutils.isCallExpression(lastPipedOperator)) {
          const lastPipedOperatorFailures = this.checkTakeuntilOperator(
            sourceFile,
            lastPipedOperator
          );
          if (lastPipedOperatorFailures.isTakeUntil) {
            lastTakeUntilFound = true;
            destroySubjectName = lastPipedOperatorFailures.destroySubjectName;
            failures.push(...lastPipedOperatorFailures.failures);
          }
        }
      }
    }

    // add failure if there is no takeUntil() in the last position of a .pipe()
    if (!lastTakeUntilFound) {
      failures.push(
        new Lint.RuleFailure(
          sourceFile,
          node.name.getStart(),
          node.name.getStart() + node.name.getWidth(),
          Rule.FAILURE_STRING,
          this.ruleName
        )
      );
    }

    return { failures, destroySubjectName: destroySubjectName };
  }

  /**
   * Checks whether there is a takeUntil() operator before operators like shareReplay()
   */
  private checkTakeuntilBeforeOperatorsInPipe(
    sourceFile: ts.SourceFile,
    pipeArguments: ts.NodeArray<ts.Expression>
  ): { failures: Lint.RuleFailure[]; destroySubjectNames: string[] } {
    const failures: Lint.RuleFailure[] = [];
    const destroySubjectNames: string[] = [];

    // go though all pipe arguments, i.e. rxjs operators
    pipeArguments.forEach((pipeArgument, i) => {
      // check whether the operator requires a preceding takeuntil
      if (
        tsutils.isCallExpression(pipeArgument) &&
        tsutils.isIdentifier(pipeArgument.expression) &&
        this.operatorsRequiringPrecedingTakeuntil.includes(
          pipeArgument.expression.getText()
        )
        && !this.isSafeRefCountOperator(pipeArgument)
      ) {
        let precedingTakeUntilOperatorFound = false;
        // check the preceding operator to be takeuntil
        if (
          i > 0 &&
          pipeArguments[i - 1] &&
          tsutils.isCallExpression(pipeArguments[i - 1])
        ) {
          const precedingOperator = pipeArguments[i - 1] as ts.CallExpression;
          const precedingOperatorFailures = this.checkTakeuntilOperator(
            sourceFile,
            precedingOperator
          );
          if (precedingOperatorFailures.isTakeUntil) {
            precedingTakeUntilOperatorFound = true;
            failures.push(...precedingOperatorFailures.failures);
            if (precedingOperatorFailures.destroySubjectName) {
              destroySubjectNames.push(
                precedingOperatorFailures.destroySubjectName
              );
            }
          }
        }

        if (!precedingTakeUntilOperatorFound) {
          failures.push(
            new Lint.RuleFailure(
              sourceFile,
              pipeArgument.getStart(),
              pipeArgument.getStart() + pipeArgument.getWidth(),
              Rule.FAILURE_STRING_OPERATOR.replace(
                "{operator}",
                pipeArgument.expression.getText()
              ),
              this.ruleName
            )
          );
        }
      }
    });

    return { failures, destroySubjectNames: destroySubjectNames };
  }

  /**
   * Checks whether the operator given is takeUntil and uses an allowed destroy subject name
   */
  private checkTakeuntilOperator(
    sourceFile: ts.SourceFile,
    operator: ts.CallExpression
  ): {
    failures: Lint.RuleFailure[];
    destroySubjectName: string | undefined;
    isTakeUntil: boolean;
  } {
    const failures: Lint.RuleFailure[] = [];
    let destroySubjectName: string | undefined;
    let isTakeUntil: boolean = false;

    if (
      tsutils.isIdentifier(operator.expression) &&
      operator.expression.text === "takeUntil"
    ) {
      isTakeUntil = true;
      // check the argument of takeUntil()
      const destroySubjectNameCheck = this.checkDestroySubjectName(
        sourceFile,
        operator
      );
      failures.push(...destroySubjectNameCheck.failures);
      destroySubjectName = destroySubjectNameCheck.destroySubjectName;
    }

    return { failures, destroySubjectName, isTakeUntil };
  }

  /**
   * Checks whether the argument of the given takeUntil(this.destroy$) expression
   * is a property of the class
   */
  private checkDestroySubjectName(
    sourceFile: ts.SourceFile,
    takeUntilOperator: ts.CallExpression
  ): { failures: Lint.RuleFailure[]; destroySubjectName: string | undefined } {
    const failures: Lint.RuleFailure[] = [];

    /** name of the takeUntil() argument */
    let destroySubjectName: string | undefined;

    /** whether the takeUntil() argument is among the allowed names */
    let isAllowedDestroySubject = false;

    let takeUntilOperatorArgument: ts.PropertyAccessExpression;
    let highlightedNode: ts.Expression = takeUntilOperator;

    // check the takeUntil() argument
    if (
      takeUntilOperator.arguments.length >= 1 &&
      takeUntilOperator.arguments[0]
    ) {
      highlightedNode = takeUntilOperator.arguments[0];
      if (tsutils.isPropertyAccessExpression(takeUntilOperator.arguments[0])) {
        takeUntilOperatorArgument = takeUntilOperator
          .arguments[0] as ts.PropertyAccessExpression;
        destroySubjectName = takeUntilOperatorArgument.name.getText();
        isAllowedDestroySubject = true;
      }
    }

    if (!isAllowedDestroySubject) {
      failures.push(
        new Lint.RuleFailure(
          sourceFile,
          highlightedNode.getStart(),
          highlightedNode.getStart() + highlightedNode.getWidth(),
          Rule.FAILURE_STRING_SUBJECT_NAME,
          this.ruleName
        )
      );
    }

    return { failures, destroySubjectName };
  }

  /**
   * Checks whether the class implements an ngOnDestroy method and invokes .next() on the destroy subjects
   */
  private checkNgOnDestroy(
    sourceFile: ts.SourceFile,
    classDeclaration: ts.ClassDeclaration,
    destroySubjectNameUsed: string
  ): Lint.RuleFailure[] {
    const failures: Lint.RuleFailure[] = [];
    const ngOnDestroyMethod = classDeclaration.members.find(
      member => member.name && member.name.getText() === "ngOnDestroy"
    );

    // check whether the ngOnDestroy method is implemented
    // and contains invocations of .next() on all destroy subjects used
    if (ngOnDestroyMethod) {
      failures.push(
        ...this.checkDestroySubjectMethodInvocation(
          sourceFile,
          ngOnDestroyMethod,
            destroySubjectNameUsed,
          "next"
        )
      );
    } else {
      failures.push(
        new Lint.RuleFailure(
          sourceFile,
            classDeclaration.name ? classDeclaration.name.getStart() : sourceFile.getStart(),
            classDeclaration.name ? classDeclaration.name.getStart() + classDeclaration.name.getWidth() : sourceFile.getStart() + sourceFile.getWidth(),
          Rule.FAILURE_STRING_NG_ON_DESTROY,
          this.ruleName
        )
      );
    }
    return failures;
  }

  /**
   * Checks whether <destroySubjectName>.<methodName>() is invoked in the ngOnDestroyMethod
   */
  private checkDestroySubjectMethodInvocation(
    sourceFile: ts.SourceFile,
    ngOnDestroyMethod: ts.ClassElement,
    destroySubjectName: string,
    methodName: string
  ) {
    const failures: Lint.RuleFailure[] = [];
    const destroySubjectMethodInvocations = tsquery(
      ngOnDestroyMethod,
      `CallExpression > PropertyAccessExpression[name.name="${methodName}"]`
    ) as ts.PropertyAccessExpression[];
    // check whether there is an invocation of <destroySubjectName>.<methodName>()
    if (
      !destroySubjectMethodInvocations.some(
        nextInvocation =>
          tsutils.isPropertyAccessExpression(nextInvocation.expression) &&
          nextInvocation.expression.name.getText() === destroySubjectName
      )
    ) {
      failures.push(
        new Lint.RuleFailure(
          sourceFile,
          ngOnDestroyMethod.name ? ngOnDestroyMethod.name.getStart() : sourceFile.getStart(),
            ngOnDestroyMethod.name ? ngOnDestroyMethod.name.getStart() +
            ngOnDestroyMethod.name.getWidth() : sourceFile.getStart() + sourceFile.getWidth(),
          Rule.FAILURE_STRING_NG_ON_DESTROY_SUBJECT_METHOD_NOT_CALLED.replace(
            "{destroySubjectName}",
            `this.${destroySubjectName}`
          ).replace("{methodName}", methodName),
          this.ruleName
        )
      );
    }
    return failures;
  }

  /**
   * Returns whether the operator is whitelisted and uses refCount: true
   * e.g. shareReplay({bufferSize: 1, refCount: true})
   */
  private isSafeRefCountOperator(operator: ts.CallExpression): boolean {
    return tsutils.isIdentifier(operator.expression)
        && this.ignoreOperatorsWithRefCountTrue.includes(operator.expression.text)
        && operator.arguments.length > 0
        && tsutils.isObjectLiteralExpression(operator.arguments[0])
        && (operator.arguments[0] as ts.ObjectLiteralExpression).properties
            .some(property => tsutils.isPropertyAssignment(property)
                && property.name.getText() === 'refCount'
                && property.initializer.kind === ts.SyntaxKind.TrueKeyword
            );
  }
}
