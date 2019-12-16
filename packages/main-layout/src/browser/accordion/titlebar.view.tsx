import * as React from 'react';

import * as styles from './styles.module.less';

export const TitleBar: React.FC<{
  title: string;
  menubar?: React.ReactNode;
}> = (props) => {
  return (
    <div className={styles.titlebar}>
      <h1>{props.title}</h1>
      {props.menubar || null}
    </div>
  );
};
