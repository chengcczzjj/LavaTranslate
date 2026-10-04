# 给识别模型的输出追加 ArgMax / ReduceMax，让 GPU 直接给出每个时间步的最佳字符与概率，
# 避免把 N×T×18710 的概率矩阵拷回 CPU
import sys
import onnx
from onnx import helper, TensorProto

src, dst = sys.argv[1], sys.argv[2]
m = onnx.load(src)
g = m.graph
out = g.output[0].name
opset = max(o.version for o in m.opset_import if o.domain in ('', 'ai.onnx'))
print('opset', opset, 'output', out)
argmax = helper.make_node('ArgMax', [out], ['best_idx'], axis=2, keepdims=0)
if opset >= 18:
    axes = helper.make_tensor('rmax_axes', TensorProto.INT64, [1], [2])
    g.initializer.append(axes)
    rmax = helper.make_node('ReduceMax', [out, 'rmax_axes'], ['best_prob'], keepdims=0)
else:
    rmax = helper.make_node('ReduceMax', [out], ['best_prob'], axes=[2], keepdims=0)
g.node.extend([argmax, rmax])
del g.output[:]
g.output.extend([
    helper.make_tensor_value_info('best_idx', TensorProto.INT64, ['N', 'T']),
    helper.make_tensor_value_info('best_prob', TensorProto.FLOAT, ['N', 'T']),
])
onnx.checker.check_model(m)
onnx.save(m, dst)
print('saved', dst)
