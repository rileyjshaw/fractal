#version 300 es
in vec4 position;
out vec2 v_texCoord;

void main() {
	gl_Position = position;
	v_texCoord = position.xy * 0.5 + 0.5; // Map from [-1,1] to [0,1]
}
