import * as React from 'react';
import * as clsx from 'classnames';
import Modal, { ModalProps } from 'antd/lib/modal';

import 'antd/lib/modal/style/index.less';

import * as styles from './styles.module.less';

export interface IOverlayProps {
  className?: string;
  width?: number;
  maskClosable?: boolean;
  visible: boolean;
  afterClose: ModalProps['afterClose'];
  onClose: ModalProps['onCancel'];
  closable?: ModalProps['closable'];
  title?: ModalProps['title'];
}

export const Overlay: React.FC<IOverlayProps> = (({ maskClosable = false, closable = true, className, onClose, children, ...restProps }) => {
  return (
    <Modal
      footer={null}
      maskClosable={maskClosable}
      closable={closable}
      onCancel={onClose}
      className={clsx(styles.overlay, className)}
      {...restProps}
    >
      {children}
    </Modal>
  );
});