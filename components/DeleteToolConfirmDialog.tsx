import React from 'react';
import { AnnotationTool } from '../types';
import { deleteToolConfirmDialog } from '../copy/ui';
import ConfirmDialog from './ConfirmDialog';

interface Props {
  tool: AnnotationTool;
  onClose: () => void;
  onDelete: () => void;
  onUnlink: () => void;
}

export default function DeleteToolConfirmDialog({ tool, onClose, onDelete, onUnlink }: Props) {
  return (
    <ConfirmDialog
      title={deleteToolConfirmDialog.title(tool.text)}
      message={<>{deleteToolConfirmDialog.unlinkExplanation}<br />{deleteToolConfirmDialog.deleteExplanation}</>}
      actions={[
        { label: deleteToolConfirmDialog.cancelButton, onClick: onClose },
        { label: deleteToolConfirmDialog.unlinkButton, onClick: onUnlink, tone: 'primary' },
        { label: deleteToolConfirmDialog.deleteButton, onClick: onDelete, tone: 'danger' },
      ]}
      onDismiss={onClose}
    />
  );
}
