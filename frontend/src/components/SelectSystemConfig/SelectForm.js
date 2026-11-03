import React from "react";
import { withTranslation } from 'react-i18next';

import "./SelectSystemConfig.scss";
import {
  Input,
  Form
} from "antd";

const FormItem = Form.Item;

/**
 * A form for instantbox requests
 *
 * 端口选项已移除：沙箱内部固定跑 ttyd，对外由 worker 按 Pod 名反代，
 * 用户既不需要也无法指定端口。
 */
export class SelectForm extends React.Component {
  static propTypes = {};
  static defaultProps = {};

  constructor(props) {
    super(props);
    this.t = props.t;
    
    this.state = {};
  }

  componentDidMount = () => {
    this.props.getForm && this.props.getForm(this.props.form);
  }

  getRules = () => {
    return {
      cpu: [
        {
          required: true,
          message: this.t('prompt.enter-cpu-core-count')
        },
        {
          validator: (rule, value, callback) => {
            if (
              (/^\d+$/g.test(value) && value >= 1 && value <= 4) ||
              value === ""
            ) {
              return callback();
            }
            callback(this.t('sentence.err-cpu-core-count'));
          },
          message: this.t('sentence.msg-cpu-core-count')
        }
      ],
      mem: [
        {
          required: true,
          message: this.t('prompt.enter-memory-in-mb')
        },
        {
          validator: (rule, value, callback) => {
            if (
              (/^\d+$/g.test(value) && value >= 64 && value <= 3584) ||
              value === ""
            ) {
              return callback();
            }
            callback(this.t('sentence.err-memory-in-mb'));
          },
          message: this.t('sentence.msg-memory-in-mb')
        }
      ],
      timeout: [
        {
          required: true,
          message: this.t('prompt.enter-ttl-in-hours')
        },
        {
          validator: (rule, value, callback) => {
            if (
              (/^\d+$/g.test(value) && value >= 1 && value <= 24) ||
              value === ""
            ) {
              return callback();
            }
            callback(this.t('sentence.err-ttl-in-hours'));
          },
          message: this.t('sentence.msg-ttl-in-hours')
        }
      ]
    }
  }

  render() {
    const { getFieldDecorator } = this.props.form;
    const formItemLayout = {
      labelCol: { span: 10 },
      wrapperCol: { span: 14 }
    };
    const rules = this.getRules()
    return (
      <Form layout="horizontal">
        <FormItem label={this.t('keyword.cpu-core-count')} {...formItemLayout}>
          {getFieldDecorator("cpu", {
            initialValue: "1",
            rules: rules.cpu
          })(<Input style={{ width: 200 }} placeholder={this.t('sentence.eg-cpu-core-count')} />)}
        </FormItem>
        <FormItem label={this.t('keyword.memory-in-mb')} {...formItemLayout}>
          {getFieldDecorator("mem", {
            initialValue: "512",
            rules: rules.mem
          })(<Input style={{ width: 200 }} placeholder={this.t('sentence.eg-memory-in-mb')} />)}
        </FormItem>
        <FormItem label={this.t('keyword.ttl-in-hours')} {...formItemLayout}>
          {getFieldDecorator("timeout", {
            initialValue: "24",
            rules: rules.timeout
          })(<Input style={{ width: 200 }} placeholder={this.t('sentence.eg-ttl-in-hours')} />)}
        </FormItem>
      </Form>
    );
  }
}

export default Form.create()(withTranslation()(SelectForm));
