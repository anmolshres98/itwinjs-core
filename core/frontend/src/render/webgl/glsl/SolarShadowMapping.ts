/*---------------------------------------------------------------------------------------------
* Copyright (c) 2019 Bentley Systems, Incorporated. All rights reserved.
* Licensed under the MIT License. See LICENSE.md in the project root for license terms.
*--------------------------------------------------------------------------------------------*/
/** @module WebGL */
import { assert } from "@bentley/bentleyjs-core";
import { VariableType, ProgramBuilder, FragmentShaderComponent } from "../ShaderBuilder";
import { TextureUnit } from "../RenderFlags";
import { addModelMatrix } from "./Vertex";
import { Vector3d } from "@bentley/geometry-core";
import { RenderType, System } from "../System";

const computeShadowPos = `
  vec4 shadowProj = u_shadowProj * MAT_MODEL * rawPosition;
  v_shadowPos = shadowProj.xyz/shadowProj.w;
  v_shadowPos.z = 1.0 - v_shadowPos.z;
`;

const scratchShadowParams = new Float32Array(4);   // Color RGB, Shadow bias.
const scratchShadowDir = new Float32Array(3);
const scratchDirection = new Vector3d();

export const getEVSMExponents = `
vec2 getEVSMExponents() {
  // max exp for 16-bit should be 5.545, for 32-bit should be 44.36
  return (u_vsm16bit > 0.5) ? vec2(5.545) : vec2(42.0);  // use same vals for pos and neg exponents
}
`;

export const warpDepth = `
// Applies exponential warp to shadow map depth, input depth should be in [0, 1]
vec2 warpDepth(float depth, vec2 exponents) {
  depth = 2.0 * depth - 1.0; // Rescale depth into [-1, 1]
  float pos =  exp( exponents.x * depth);
  float neg = -exp(-exponents.y * depth);
  return vec2(pos, neg);
}
`;

const chebyshevUpperBound = `
float chebyshevUpperBound(vec2 moments, float mean, float minVariance) {
  float variance = moments.y - (moments.x * moments.x);
  variance = max(variance, minVariance);

  // Compute probabilistic upper bound
  float d = mean - moments.x;
  float pMax = variance / (variance + (d * d));

  return (mean <= moments.x ? 1.0 : pMax);  // One-tailed Chebyshev
}
`;

const shadowMapEVSM = `
float shadowMapEVSM(vec3 shadowPos) {
  vec2 exponents = getEVSMExponents();
  vec2 warpedDepth = warpDepth(shadowPos.z, exponents);
  vec4 occluder = TEXTURE(s_shadowSampler, shadowPos.xy * 0.5); // shadow texture is 1/2 size (both dirs)

  // Derivative of warping at depth
  vec2 depthScale = kVSMBias * 0.01 * exponents * warpedDepth;
  vec2 minVariance = depthScale * depthScale;

  float posContrib = chebyshevUpperBound(occluder.xz, warpedDepth.x, minVariance.x);
  float negContrib = chebyshevUpperBound(occluder.yw, warpedDepth.y, minVariance.y);
  return min(posContrib, negContrib);
}
`;

const applySolarShadowMap = `
  if (v_shadowPos.x < 0.0 || v_shadowPos.x > 1.0 || v_shadowPos.y < 0.0 || v_shadowPos.y > 1.0 || v_shadowPos.z < 0.0 || v_shadowPos.z > 1.0)
    return baseColor;
  vec3 toEye = mix(vec3(0.0, 0.0, -1.0), normalize(v_eyeSpace), float(kFrustumType_Perspective == u_frustum.z));
  vec3 normal = normalize(v_n);
  normal = (dot(normal, toEye) > 0.0) ? -normal : normal;
  float visible = (isSurfaceBitSet(kSurfaceBit_HasNormals) && (dot(normal, u_shadowDir) > 0.0)) ? 0.0 : shadowMapEVSM(v_shadowPos);
  return vec4(baseColor.rgb * mix(u_shadowParams.rgb, vec3(1.0), visible), baseColor.a);
  `;

/** @internal */
export function addSolarShadowMap(builder: ProgramBuilder) {
  const frag = builder.frag;
  const vert = builder.vert;

  frag.addUniform("s_shadowSampler", VariableType.Sampler2D, (prog) => {
    prog.addGraphicUniform("s_shadowSampler", (uniform, params) => {
      const shadowMap = params.target.solarShadowMap!;
      assert(undefined !== shadowMap && undefined !== shadowMap.shadowMapTexture);
      shadowMap.shadowMapTexture!.texture.bindSampler(uniform, TextureUnit.ShadowMap);
    });
  });

  frag.addUniform("u_shadowParams", VariableType.Vec4, (prog) => {
    prog.addGraphicUniform("u_shadowParams", (uniform, params) => {
      const shadowMap = params.target.solarShadowMap!;
      assert(undefined !== shadowMap);
      const colors = shadowMap.settings.color.colors;
      scratchShadowParams[0] = colors.r / 255.0;
      scratchShadowParams[1] = colors.g / 255.0;
      scratchShadowParams[2] = colors.b / 255.0;
      scratchShadowParams[3] = shadowMap.settings.bias;
      uniform.setUniform4fv(scratchShadowParams);
    });
  });

  frag.addUniform("u_shadowDir", VariableType.Vec3, (prog) => {
    prog.addGraphicUniform("u_shadowDir", (uniform, params) => {
      const shadowMap = params.target.solarShadowMap!;
      const mv = params.modelViewMatrix;
      const worldDirection = shadowMap.direction!;
      scratchDirection.x = mv.m00 * worldDirection.x + mv.m01 * worldDirection.y + mv.m02 * worldDirection.z;
      scratchDirection.y = mv.m10 * worldDirection.x + mv.m11 * worldDirection.y + mv.m12 * worldDirection.z;
      scratchDirection.z = mv.m20 * worldDirection.x + mv.m21 * worldDirection.y + mv.m22 * worldDirection.z;
      scratchDirection.normalizeInPlace();

      scratchShadowDir[0] = scratchDirection.x;
      scratchShadowDir[1] = scratchDirection.y;
      scratchShadowDir[2] = scratchDirection.z;
      uniform.setUniform3fv(scratchShadowDir);
    });
  });

  vert.addUniform("u_shadowProj", VariableType.Mat4, (prog) => {
    prog.addGraphicUniform("u_shadowProj", (uniform, params) => {
      const shadowMap = params.target.solarShadowMap!;
      assert(undefined !== shadowMap);
      uniform.setMatrix4(shadowMap.projectionMatrix);
    });
  });

  addModelMatrix(vert);

  frag.addUniform("u_vsm16bit", VariableType.Float, (prog) => {
    prog.addGraphicUniform("u_vsm16bit", (uniform) => {
      const isEVSM16bit = (RenderType.TextureFloat !== System.instance.capabilities.maxRenderType) ? 1 : 0;
      uniform.setUniform1f(isEVSM16bit);
    });
  });

  builder.addInlineComputedVarying("v_shadowPos", VariableType.Vec3, computeShadowPos);
  frag.addGlobal("kVSMBias", VariableType.Float, "0.1", true);
  frag.addFunction(getEVSMExponents);
  frag.addFunction(warpDepth);
  frag.addFunction(chebyshevUpperBound);
  frag.addFunction(shadowMapEVSM);
  frag.set(FragmentShaderComponent.ApplySolarShadowMap, applySolarShadowMap);
}
