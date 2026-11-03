import React, { Fragment } from "react";
import PropTypes from "prop-types";
import { withTranslation } from 'react-i18next';

import { Divider, Form } from "antd";
const formItemLayout = {
  labelCol: { span: 12 },
  wrapperCol: { span: 12 }
};
const FormItem = Form.Item;

const customLabel = title => {
  return (
    <span style={{ display: "inline-block", width: 110, textAlign: "right" }}>
      {title}
    </span>
  );
};

/**
 * Show current system configuration
 *
 * 端口相关字段（内部/外部端口）已随「开放端口」选项一起移除。
 */
class SystemConfiguration extends React.Component {
  static propTypes = {
    /**
     * OS name
     */
    system: PropTypes.string,

    /**
     * OS version
     */
    version: PropTypes.string,

    /**
     * CPU
     */
    cpu: PropTypes.any,

    /**
     * Memory
     */
    mem: PropTypes.any,

    /**
     * Time-to-live
     */
    timeout: PropTypes.any
  };

  constructor(props) {
    super(props);
    this.t = props.t;
  }

  getSystemVersion = () => {
    const { system, version } = this.props;
    return (
      <Fragment>
        {system}
        <Divider type="vertical" />
        {version}
      </Fragment>
    );
  };

  render() {
    const { cpu, mem, timeout } = this.props;

    return (
      <Form>
        <FormItem label={customLabel(this.t('keyword.os'))} {...formItemLayout}>
          {this.getSystemVersion()}
        </FormItem>
        <FormItem label={customLabel(this.t('keyword.cpu-core-count'))} {...formItemLayout}>
          {cpu}
        </FormItem>
        <FormItem label={customLabel(this.t('keyword.memory'))} {...formItemLayout}>
          {mem} M（{(mem / 1024).toFixed(2)} G）
        </FormItem>
        <FormItem label={customLabel(this.t('keyword.ttl-in-hours'))} {...formItemLayout}>
          {timeout}
        </FormItem>
      </Form>
    );
  }
}

export default Form.create()(withTranslation()(SystemConfiguration));
