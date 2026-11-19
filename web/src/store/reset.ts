import { useAttachmentStore } from './attachment.store';
import { useCustomerStore } from './customer.store';
import { useFollowUpStore } from './followup.store';
import { useLetterStore } from './letter.store';
import { useMetaStore } from './meta.store';
import { useProjectStore } from './project.store';
import { useQuotationStore } from './quotation.store';
import { useTemplateStore } from './template.store';
import { useUiStore } from './ui.store';
import { useUserStore } from './user.store';

/**
 * Reset every business Zustand store when logging out or when a session expires,
 * preventing cross-account / cross-organization data leakage in SPA memory.
 */
export function resetAllBusinessStores(): void {
  useProjectStore.getState().reset();
  useCustomerStore.setState(useCustomerStore.getInitialState(), true);
  useLetterStore.setState(useLetterStore.getInitialState(), true);
  useTemplateStore.setState(useTemplateStore.getInitialState(), true);
  useFollowUpStore.setState(useFollowUpStore.getInitialState(), true);
  useQuotationStore.setState(useQuotationStore.getInitialState(), true);
  useAttachmentStore.setState(useAttachmentStore.getInitialState(), true);
  useUserStore.setState(useUserStore.getInitialState(), true);
  useMetaStore.setState(useMetaStore.getInitialState(), true);
  useUiStore.setState(useUiStore.getInitialState(), true);
}
