<script setup lang="ts">
import { signImageUrl } from '../services/local-signs'
const props = defineProps<{
  kind: 'reg' | 'cone' | 'car' | 'complex' | 'pit'
  width: number
  height: number
  knownSigns: Set<string>
  revisions?: Record<string, number>
}>()

function signUrl(code: string): string {
  const revision = props.revisions?.[code]
  return signImageUrl(code, revision)
}
</script>

<template>
  <span
    class="symbol"
    :class="`symbol-${kind}`"
    :style="{ width: `${Math.max(width, 24)}px`, height: `${Math.max(height, 28)}px` }"
    :aria-label="
      {
        reg: 'Регулировщик с жезлом',
        cone: 'Дорожный конус',
        car: 'Машина прикрытия',
        complex: 'Переносной комплекс знаков',
        pit: 'Место производства работ',
      }[kind]
    "
    role="img"
  >
    <template v-if="kind === 'reg'">
      <span class="head" /><span class="vest" /><span class="reflector one" />
      <span class="reflector two" /><span class="left-arm" /><span class="right-arm" />
      <span class="baton" /><span class="left-leg" /><span class="right-leg" />
    </template>
    <template v-else-if="kind === 'car'">
      <span class="beacon" /><span class="body" /><span class="cab" /><span class="window" />
      <span class="wheel left" /><span class="wheel right" />
      <span class="mandatory">
        <img v-if="knownSigns.has('4.2.2')" :src="signUrl('4.2.2')" alt="" data-sign-code="4.2.2" />
        <span v-else class="missing">?</span>
      </span>
    </template>
    <template v-else-if="kind === 'cone'">
      <span class="cone-body" /><span class="cone-stripe" /><span class="cone-base" />
    </template>
    <template v-else-if="kind === 'complex'">
      <span class="sign-board">
        <img v-if="knownSigns.has('1.25')" :src="signUrl('1.25')" alt="" data-sign-code="1.25" />
        <span v-else class="missing">?</span>
        <img v-if="knownSigns.has('4.2.2')" :src="signUrl('4.2.2')" alt="" data-sign-code="4.2.2" />
        <span v-else class="missing">?</span>
      </span>
      <span class="sign-stand" />
    </template>
    <span v-else class="pit-hatch" />
  </span>
</template>

<style scoped>
.symbol {
  display: inline-block;
  position: relative;
  box-sizing: border-box;
  flex: none;
  vertical-align: middle;
  isolation: isolate;
}
.symbol * {
  position: absolute;
  box-sizing: border-box;
}
.symbol-reg .head {
  left: 32%;
  top: 1%;
  width: 30%;
  height: 17%;
  border-radius: 50%;
  background: #222;
}
.symbol-reg .vest {
  left: 22%;
  top: 21%;
  width: 55%;
  height: 40%;
  border: 1px solid #222;
  border-radius: 20% 20% 8% 8%;
  background: #ff7a00;
}
.symbol-reg .reflector {
  left: 26%;
  width: 47%;
  height: 4%;
  background: #e8eef0;
}
.symbol-reg .one {
  top: 38%;
}
.symbol-reg .two {
  top: 49%;
}
.symbol-reg .left-arm {
  left: 10%;
  top: 26%;
  width: 10%;
  height: 32%;
  background: #222;
  transform: rotate(18deg);
  transform-origin: top;
}
.symbol-reg .right-arm {
  left: 78%;
  top: 27%;
  width: 10%;
  height: 30%;
  background: #222;
  transform: rotate(-48deg);
  transform-origin: top;
}
.symbol-reg .baton {
  left: 87%;
  top: 37%;
  width: 20%;
  height: 10%;
  border: 1px solid white;
  border-radius: 50%;
  background: #e30613;
}
.symbol-reg .left-leg,
.symbol-reg .right-leg {
  top: 62%;
  width: 15%;
  height: 36%;
  background: #222;
}
.symbol-reg .left-leg {
  left: 28%;
  transform: skewX(-10deg);
}
.symbol-reg .right-leg {
  left: 57%;
  transform: skewX(10deg);
}
.symbol-car .beacon {
  left: 39%;
  top: 8%;
  width: 15%;
  height: 7%;
  border-radius: 30%;
  background: #1359a0;
}
.symbol-car .body {
  left: 5%;
  top: 18%;
  width: 65%;
  height: 31%;
  border: 2px solid #875408;
  border-radius: 9% 7% 4% 4%;
  background: #ed9b18;
}
.symbol-car .cab {
  left: 63%;
  top: 27%;
  width: 31%;
  height: 22%;
  border: 2px solid #875408;
  border-radius: 8% 25% 7% 2%;
  background: #ed9b18;
}
.symbol-car .window {
  left: 68%;
  top: 29%;
  width: 18%;
  height: 10%;
  background: #d9edf8;
}
.symbol-car .wheel {
  top: 46%;
  width: 14%;
  height: 13%;
  border-radius: 50%;
  background: #26313a;
}
.symbol-car .wheel.left {
  left: 18%;
}
.symbol-car .wheel.right {
  left: 72%;
}
.symbol-car .mandatory {
  left: 6%;
  top: 62%;
  width: 28%;
  height: 35%;
  border: 2px solid #303b45;
  background: white;
}
.symbol-car .mandatory img {
  position: static;
  width: 100%;
  height: 100%;
  object-fit: contain;
}
.symbol-car .mandatory .missing {
  position: static;
}
.symbol-cone .cone-body {
  left: 20%;
  top: 0;
  width: 60%;
  height: 79%;
  background: #e4032e;
  clip-path: polygon(34% 0, 66% 0, 100% 100%, 0 100%);
}
.symbol-cone .cone-stripe {
  left: 29%;
  top: 36%;
  width: 42%;
  height: 14%;
  background: white;
  clip-path: polygon(12% 0, 88% 0, 100% 100%, 0 100%);
}
.symbol-cone .cone-base {
  left: 9%;
  top: 79%;
  width: 82%;
  height: 17%;
  background: #323b44;
}
.sign-board {
  left: 5%;
  top: 1%;
  width: 90%;
  height: 73%;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 2px solid #303b45;
  background: white;
}
.sign-board img,
.sign-board .missing {
  position: static;
  width: 48%;
  height: 90%;
  object-fit: contain;
}
.missing {
  text-align: center;
  color: #a22030;
}
.sign-stand {
  left: 49%;
  top: 73%;
  width: 3%;
  height: 22%;
  background: #303b45;
}
.sign-stand::after {
  content: '';
  position: absolute;
  bottom: 0;
  left: -800%;
  width: 1700%;
  height: 10%;
  background: #303b45;
}
.pit-hatch {
  inset: 0;
  border: 2px solid #303b45;
  background: repeating-linear-gradient(130deg, white 0 8px, #8795a1 8px 10px);
}
</style>
