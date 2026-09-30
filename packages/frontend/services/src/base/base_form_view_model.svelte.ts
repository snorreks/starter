// packages/frontend/services/src/base/base_form_view_model.svelte.ts
//
// Form base: state, validation and submit lifecycle, with the rules coming from
// the TypeBox schema rather than from hand-written field checks.
//
// The point of deriving validation from the schema is that the client and the
// server validate the same shape. A form that checks `title.length` in one
// place and the API checks a different constant is two sources of truth, and
// they drift.

import { type Static, type TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import {
  BaseViewModel,
  type BaseViewModelInterface,
  type BaseViewModelOptions,
} from './base_view_model.svelte.ts';

export type BaseFormViewModelOptions<FormSchema extends TSchema> = BaseViewModelOptions & {
  schema: FormSchema;
  initialValues: Static<FormSchema>;
  /** Async initial values (e.g. loading a draft). Overrides `initialValues`. */
  getInitialValues?: () => Promise<Static<FormSchema>>;
  /**
   * Called with validated values when the form is submitted.
   *
   * Optional so a subclass that overrides `handleSubmit()` is not forced to
   * supply a callback it will never run. Omitting it means `handleSubmit()`
   * validates and returns `true` without submitting anything.
   */
  onSubmit?: (values: Static<FormSchema>) => Promise<void>;
};

export type BaseFormViewModelInterface<FormSchema extends TSchema> = {
  readonly form: Static<FormSchema>;
  /** Field name -> first validation message. */
  readonly errors: Readonly<Record<string, string>>;
  readonly isSubmitting: boolean;
  readonly isValid: boolean;
  /** Re-validate a single field, e.g. after blur. */
  handleChange(key: string): Promise<void>;
  /** Validate and submit. Returns whether the submit was accepted. */
  handleSubmit(): Promise<boolean>;
  reset(): Promise<void>;
} & BaseViewModelInterface;

export abstract class BaseFormViewModel<
  FormSchema extends TSchema,
  Options extends BaseViewModelOptions = BaseViewModelOptions,
> extends BaseViewModel<Options> implements BaseFormViewModelInterface<FormSchema> {
  form = $state({} as Static<FormSchema>);
  isSubmitting = $state(false);

  protected _errors = $state<Record<string, string>>({});

  readonly #schema: FormSchema;
  readonly #initialValues: Static<FormSchema>;
  readonly #loadInitialValues: (() => Promise<Static<FormSchema>>) | undefined;
  readonly #onSubmit: ((values: Static<FormSchema>) => Promise<void>) | undefined;

  constructor(options: BaseFormViewModelOptions<FormSchema> & Options) {
    super(options);
    this.#schema = options.schema;
    this.#initialValues = options.initialValues;
    this.form = options.initialValues;
    this.#loadInitialValues = options.getInitialValues;
    this.#onSubmit = options.onSubmit;
  }

  isValid = $derived(Object.values(this._errors).every((message) => !message));

  errors = $derived(
    Object.fromEntries(
      Object.entries(this._errors).filter((entry): entry is [string, string] => Boolean(entry[1])),
    ),
  );

  override async initialize(): Promise<void> {
    if (this.#loadInitialValues) {
      this.form = await this.#loadInitialValues();
    }
  }

  async handleChange(key: string): Promise<void> {
    await this.validateField(key);
  }

  async handleSubmit(): Promise<boolean> {
    // Guard rather than queue: a double-click on a submit button is a UI bug,
    // not something to serialize.
    if (this.isSubmitting) {
      this.warn('handleSubmit: already submitting');
      return false;
    }

    const validation = this.#validate();
    if (!validation.ok) {
      this._errors = validation.errors;
      return false;
    }

    this.isSubmitting = true;
    try {
      await this.#onSubmit?.(this.form);
      return true;
    } finally {
      this.isSubmitting = false;
    }
  }

  async reset(): Promise<void> {
    this.form = this.#loadInitialValues ? await this.#loadInitialValues() : this.#initialValues;
    this._errors = {};
  }

  async validateField(key: string): Promise<void> {
    const validation = this.#validate();

    // Keep other fields' messages: a single-field revalidation must not clear
    // feedback the user has not yet addressed.
    this._errors = {
      ...(validation.ok ? {} : validation.errors),
      [key]: validation.ok ? '' : (validation.errors[key] ?? ''),
    };
  }

  override async dispose(): Promise<void> {
    await this.reset();
    await super.dispose();
  }

  #validate(): { ok: true } | { ok: false; errors: Record<string, string> } {
    if (Value.Check(this.#schema, this.form)) {
      return { ok: true };
    }

    const errors: Record<string, string> = {};
    // `Value.Errors` yields a flat list; a nested object produces one entry per
    // leaf. `_form` collects failures with no addressable field, so a malformed
    // payload still produces a message instead of an empty error map.
    for (const issue of Value.Errors(this.#schema, this.form)) {
      const field = issue.path.replace(/^\//, '') || '_form';
      if (!errors[field]) {
        errors[field] = issue.message;
      }
    }

    return { ok: false, errors };
  }
}
