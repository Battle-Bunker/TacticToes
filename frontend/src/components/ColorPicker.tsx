import React, { useRef } from "react";
import {
  Box,
  Typography,
} from "@mui/material";
import { ColorLens } from "@mui/icons-material";

interface ColorPickerProps {
  selectedColor: string;
  onColorChange: (color: string) => void;
  label?: string;
}

export const ColorPicker: React.FC<ColorPickerProps> = ({
  selectedColor,
  onColorChange,
  label = "Color",
}) => {
  const hiddenInputRef = useRef<HTMLInputElement>(null);

  const handleColorChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    onColorChange(event.target.value);
  };

  const handleOpenColorPicker = () => {
    hiddenInputRef.current?.click();
  };

  return (
    <>
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 1,
          cursor: "pointer",
          padding: 1,
          borderRadius: 1,
          border: "2px solid transparent",
          "&:hover": {
            border: "2px solid #1976d2",
            backgroundColor: "rgba(25, 118, 210, 0.04)",
          },
          transition: "all 0.2s ease-in-out",
        }}
        onClick={handleOpenColorPicker}
      >
        <Box
          sx={{
            width: 32,
            height: 32,
            borderRadius: "50%",
            backgroundColor: selectedColor,
            border: "2px solid #fff",
            boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            position: "relative",
            "&::after": {
              content: '""',
              position: "absolute",
              width: "100%",
              height: "100%",
              borderRadius: "50%",
              border: "1px solid rgba(0,0,0,0.1)",
            },
          }}
        >
          <ColorLens sx={{ fontSize: 16, color: "#fff", filter: "drop-shadow(0 1px 2px rgba(0,0,0,0.3))" }} />
        </Box>
        <Typography variant="body2" sx={{ fontWeight: 500, color: "#666" }}>
          {label}
        </Typography>
      </Box>

      <input
        ref={hiddenInputRef}
        type="color"
        value={selectedColor}
        onChange={handleColorChange}
        style={{ display: "none" }}
      />
    </>
  );
};